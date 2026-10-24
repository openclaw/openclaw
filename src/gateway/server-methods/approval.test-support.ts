import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import { getOperatorApprovalDetailedInDatabase } from "../operator-approval-store.kernel.worker.js";
import type { OperatorApprovalDatabase } from "../operator-approval-store.types.js";
import { SharedGatewaySessionGenerationState } from "../server-shared-auth-generation.js";
import { createOperatorWsClient } from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createApprovalRequestAuthority } from "./approval-request-authority.js";
import { handleApprovalResolve as handleOwnedApprovalResolve } from "./approval-shared.js";
import type { createApprovalHandlers } from "./approval.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
} from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestOptions } from "./types.js";

export function getOperatorApproval(
  params: Parameters<typeof getOperatorApprovalDetailedInDatabase>[0],
) {
  const result = getOperatorApprovalDetailedInDatabase(params);
  return result.outcome === "found" ? result.record : null;
}

export function deleteDurableApproval(
  databaseOptions: OpenClawStateDatabaseOptions,
  id: string,
): void {
  const { db } = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.deleteFrom("operator_approvals").where("approval_id", "=", id),
  );
}

export function corruptDurableApprovalPresentation(
  databaseOptions: OpenClawStateDatabaseOptions,
  id: string,
): void {
  const { db } = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("operator_approvals")
      .set({ presentation_json: "{}" })
      .where("approval_id", "=", id),
  );
}

export function createClient(params: {
  scopes?: string[];
  deviceId?: string;
  internal?: boolean;
  connId?: string;
}): GatewayWsClient {
  const client = createOperatorWsClient({
    connId: params.connId ?? (params.deviceId ? `conn-${params.deviceId}` : "conn-no-device"),
    scopes: params.scopes ?? ["operator.approvals"],
    clientInfo: { id: "approval-test", mode: "backend" },
  });
  client.connect.client.displayName = "Approval Test";
  if (params.deviceId) {
    client.connect.device = {
      id: params.deviceId,
      publicKey: "synthetic-public-key",
      signature: "synthetic-signature",
      signedAt: 1,
      nonce: "synthetic-nonce",
    };
  }
  if (params.internal) {
    client.internal = { approvalRuntime: true };
  }
  return client;
}

export function createContext(
  controlUiBasePath?: string,
  approvalWebPushDelivery?: GatewayRequestHandlerOptions["context"]["approvalWebPushDelivery"],
) {
  const cfg = { gateway: { controlUi: { basePath: controlUiBasePath } } };
  // SAFETY: This bound-handler fixture supplies the approval context members; no server is started.
  return {
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    approvalEvents: {
      publishRequested: vi.fn(() => 0),
      publishResolved: vi.fn(),
    },
    getApprovalClientConnIds: vi.fn(() => new Set(["approval-client"])),
    getRuntimeConfig: () => cfg,
    approvalWebPushDelivery,
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
}

type ApprovalInvocationParams = {
  handlers: ReturnType<typeof createApprovalHandlers>;
  method:
    | `approval.${"get" | "history" | "resolve"}`
    | `exec.approval.${"get" | "list" | "grants.list" | "grants.revoke" | "resolve" | "waitDecision"}`
    | `plugin.approval.${"list" | "resolve"}`;
  body: Record<string, unknown>;
  client: GatewayWsClient | null;
  context?: GatewayRequestHandlerOptions["context"];
  sessionMutationCommitGuard?: () => void;
  transport?: "websocket" | "sdk";
};

export function createApprovalInvocation(params: ApprovalInvocationParams) {
  const respond = vi.fn();
  const context = params.context ?? createContext();
  const client = params.client;
  const capture = captureGatewayDeviceRevocation(
    context,
    { deviceId: client?.connect.device?.id, role: client?.connect.role ?? "operator" },
    () => !client?.invalidated,
    client?.connectionSignal,
  );
  const request: GatewayRequestOptions = {
    req: { id: "req-1", type: "req", method: params.method, params: params.body },
    client,
    context,
    isWebchatConnect: () => false,
    respond,
    hasCurrentClientAuthority: capture.isCurrent,
    ...(params.sessionMutationCommitGuard
      ? { sessionMutationCommitGuard: params.sessionMutationCommitGuard }
      : {}),
  };
  if (client && params.transport !== "sdk") {
    bindWebSocketRequestMutationAuthority(
      request,
      client,
      new SharedGatewaySessionGenerationState({ current: undefined, required: null }).reader,
    );
  }
  const options = bindGatewayRequestHandlerMutationAuthority(
    request,
    { ...request, params: params.body },
    undefined,
  );
  return {
    context,
    respond,
    invoke: async () => {
      try {
        await expectDefined(params.handlers[params.method], "approval handler")(options);
        const [ok, result, error] = expectDefined(
          respond.mock.calls[0],
          "approval handler did not respond",
        );
        return { ok, result, error, context };
      } finally {
        capture.release();
      }
    },
  };
}

/** Direct helper fixtures use native SDK custody; transport proofs bind their real request owner. */
export async function handleApprovalResolve<
  TPayload extends ExecApprovalRequestPayload | PluginApprovalRequestPayload,
>(params: Omit<Parameters<typeof handleOwnedApprovalResolve<TPayload>>[0], "authority">) {
  const context = {
    ...createContext(),
    ...params.context,
    getApprovalClientConnIds: params.context.getApprovalClientConnIds,
  };
  const options: GatewayRequestHandlerOptions = {
    req: { id: "req", type: "req", method: `${params.approvalKind}.approval.resolve` },
    params: { id: params.inputId, decision: params.decision },
    context,
    client: params.client,
    respond: params.respond,
    isWebchatConnect: () => false,
  };
  using authority = createApprovalRequestAuthority(options);
  return await handleOwnedApprovalResolve({ ...params, context, authority });
}

export function requestedEvent<TPayload>(record: ExecApprovalRecord<TPayload>) {
  return {
    id: record.id,
    request: record.request,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
}
