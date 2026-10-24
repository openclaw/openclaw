import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import {
  resolvePluginApprovalRequestAllowedDecisions,
  type PluginApprovalRequestPayload,
} from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { createApprovalHandlers } from "./approval.js";
import { createContext } from "./approval.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function getOperatorApproval(
  params: Parameters<typeof getOperatorApprovalDetailed>[0],
) {
  const result = await getOperatorApprovalDetailed({ nowMs: Date.now(), ...params });
  return result.outcome === "found" ? result.record : null;
}

export const tempDirs: string[] = [];
const managersForCleanup: Array<{
  listPendingRecords(): Promise<Array<{ id: string }>>;
  expire(id: string, resolvedBy?: string | null): Promise<boolean>;
}> = [];

export function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-handler-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

export function createManagers(databaseOptions: OpenClawStateDatabaseOptions) {
  const common = {
    scheduler: createTestGatewayScheduler(),
    persistence: { runtimeEpoch: "approval-handler-test", databaseOptions },
    resolveAudienceSessionKeys: (source: string) => [source, "agent:main:parent"],
  };
  const managers = {
    exec: new ExecApprovalManager<ExecApprovalRequestPayload>({
      ...common,
      approvalKind: "exec",
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    }),
    plugin: new ExecApprovalManager<PluginApprovalRequestPayload>({
      ...common,
      approvalKind: "plugin",
      resolveAllowedDecisions: resolvePluginApprovalRequestAllowedDecisions,
    }),
    systemAgent: new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      ...common,
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
    }),
  };
  managersForCleanup.push(managers.exec, managers.plugin, managers.systemAgent);
  return managers;
}

export function createHandlers(
  managers: ReturnType<typeof createManagers>,
  databaseOptions: OpenClawStateDatabaseOptions,
  options: Omit<
    Parameters<typeof createApprovalHandlers>[0],
    "execApprovalManager" | "pluginApprovalManager" | "databaseOptions"
  > = {},
) {
  return createApprovalHandlers({
    execApprovalManager: managers.exec,
    pluginApprovalManager: managers.plugin,
    databaseOptions,
    ...options,
  });
}

export function createFixture(includeSystemAgent = false) {
  const databaseOptions = createDatabaseOptions();
  const managers = createManagers(databaseOptions);
  const handlers = createHandlers(managers, databaseOptions, {
    systemAgentApprovalManager: includeSystemAgent ? managers.systemAgent : undefined,
  });
  return { databaseOptions, managers, handlers, request: bindApprovalHandlers(handlers) };
}

export function bindApprovalHandlers(handlers: ReturnType<typeof createApprovalHandlers>) {
  return (
    method: Parameters<typeof invoke>[0]["method"],
    body: Record<string, unknown>,
    client = createClient({ deviceId: "reviewer" }),
    context?: GatewayRequestHandlerOptions["context"],
  ) => invoke({ handlers, method, body, client, context });
}

export async function registerExec(
  manager: ExecApprovalManager,
  params: {
    id: string;
    request?: Partial<ExecApprovalRequestPayload>;
    expiresAtMs?: number;
    requester?: {
      connId?: string | null;
      deviceId?: string | null;
      clientId?: string | null;
    };
    reviewerDeviceIds?: string[];
  },
) {
  const record = manager.create(
    {
      command: "printf approval-handler",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:child",
      ...params.request,
    },
    600_000,
    params.id,
  );
  const requester = {
    deviceId: "requester-device",
    clientId: "requester-client",
    ...params.requester,
  };
  record.requestedByConnId = requester.connId ?? null;
  record.requestedByDeviceId = requester.deviceId;
  record.requestedByClientId = requester.clientId;
  record.requestedByDeviceTokenAuth = true;
  record.approvalReviewerDeviceIds = params.reviewerDeviceIds ?? ["reviewer"];
  if (params.expiresAtMs !== undefined) {
    record.expiresAtMs = params.expiresAtMs;
  }
  const decision = (await manager.register(record, 600_000)).decision;
  return { record, decision };
}

export async function registerSystemAgent(
  manager: ExecApprovalManager<SystemAgentApprovalRequestPayload>,
  id: string,
) {
  const record = manager.create(
    {
      title: "OpenClaw change",
      description: "Set gateway.port to 19001",
      command: "Set gateway.port to 19001",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "delegation-1",
    },
    600_000,
    id,
  );
  const decision = (await manager.register(record, 600_000)).decision;
  return { record, decision };
}

export async function registerPlugin(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: {
    id: string;
    request?: Partial<PluginApprovalRequestPayload>;
    reviewerDeviceIds?: string[];
  },
) {
  const record = manager.create(
    {
      title: "Plugin permission",
      description: "Allow one guarded plugin operation",
      severity: "warning",
      pluginId: "example-plugin",
      toolName: "example-tool",
      agentId: "main",
      sessionKey: "agent:main:child",
      ...params.request,
    },
    600_000,
    params.id,
  );
  record.requestedByDeviceId = "requester-device";
  record.requestedByClientId = "requester-client";
  record.requestedByDeviceTokenAuth = true;
  record.approvalReviewerDeviceIds = params.reviewerDeviceIds ?? ["reviewer"];
  const decision = (await manager.register(record, 600_000)).decision;
  return { record, decision };
}

export function createClient(params: {
  scopes?: string[];
  deviceId?: string;
  internal?: boolean;
  connId?: string;
}): GatewayRequestHandlerOptions["client"] {
  return {
    connId: params.connId ?? (params.deviceId ? `conn-${params.deviceId}` : "conn-no-device"),
    connect: {
      client: { id: "approval-test", displayName: "Approval Test" },
      scopes: params.scopes ?? ["operator.approvals"],
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    ...(params.internal ? { internal: { approvalRuntime: true } } : {}),
  } as unknown as GatewayRequestHandlerOptions["client"];
}

export async function invoke(params: {
  handlers: ReturnType<typeof createApprovalHandlers>;
  method: "approval.get" | "approval.history" | "approval.resolve";
  body: Record<string, unknown>;
  client: GatewayRequestHandlerOptions["client"];
  context?: GatewayRequestHandlerOptions["context"];
}) {
  const respond = vi.fn();
  const context = params.context ?? createContext();
  await expectDefined(
    params.handlers[params.method],
    "approval handler",
  )({
    req: { id: "req-1", type: "req", method: params.method, params: params.body },
    params: params.body,
    client: params.client,
    context,
    isWebchatConnect: () => false,
    respond,
  });
  const [ok, result, error] = expectDefined(
    respond.mock.calls[0],
    "approval handler did not respond",
  );
  return { ok, result, error, context };
}

export async function cleanupApprovalHandlerFixtures(): Promise<void> {
  for (const manager of managersForCleanup.splice(0)) {
    for (const record of await manager.listPendingRecords()) {
      await manager.expire(record.id, "test-cleanup");
    }
  }
  closeOpenClawAgentDatabasesForTest();
  for (const dir of tempDirs.splice(0)) {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: dir }),
    );
    await closeOpenClawStateDatabaseByPathAsync(path.join(dir, "state.sqlite"));
    fs.rmSync(dir, { force: true, recursive: true });
  }
}
