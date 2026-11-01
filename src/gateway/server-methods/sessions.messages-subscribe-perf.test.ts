import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingApprovalSnapshot } from "../../../packages/gateway-protocol/src/schema/approvals.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createOperatorApprovalSessionEventRuntime } from "../operator-approval-session-events.js";
import * as store from "../operator-approval-store.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it("shares approval replay across 64 subscribers during unrelated approval activity", async () => {
  const stateDir = tempDirs.make("subscribe-approval-perf-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const databaseOptions = { env: process.env };
  const sessionKey = "agent:main:perf";
  const expected: PendingApprovalSnapshot[] = [];
  let unrelatedApproval: store.OperatorApprovalRecord | undefined;
  for (let index = 0; index <= 200; index += 1) {
    const sourceSessionKey = index < 200 ? sessionKey : `${sessionKey}-unrelated`;
    const id = `approval-${String(index).padStart(3, "0")}`;
    const presentation = {
      kind: "exec" as const,
      commandText: `printf synthetic-${index}`,
      commandPreview: null,
      warningText: null,
      host: "gateway" as const,
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"] as ("allow-once" | "deny")[],
    };
    const snapshot = {
      id,
      presentation,
      createdAtMs: 1000 + index,
      expiresAtMs: 60_000,
    };
    const inserted = await store.insertOperatorApproval({
      databaseOptions,
      approval: {
        ...snapshot,
        kind: "exec",
        runtimeEpoch: "synthetic-epoch",
        source: { agentId: "main", sessionKey: sourceSessionKey },
        audienceSessionKeys: [sourceSessionKey],
        reviewerDeviceIds: ["reviewer"],
      },
    });
    assert(inserted.outcome === "inserted", "Expected a new synthetic approval");
    if (index === 200) {
      unrelatedApproval = inserted.record;
      continue;
    }
    expected.push({
      ...snapshot,
      status: "pending",
      urlPath: `/approve/${id}`,
      sourceSessionKey: sessionKey,
    });
  }
  assert(unrelatedApproval, "Expected the unrelated synthetic approval");
  const unrelated = unrelatedApproval;
  const clients = Array.from({ length: 64 }, (_, index) => ({
    connId: `subscriber-${index}`,
    connect: { client: { id: "test" }, scopes: ["operator.admin"] },
  })) as GatewayClient[];
  const subscribers = createSessionMessageSubscriberRegistry();
  vi.spyOn(Date, "now").mockReturnValue(5000);
  const runtime = createOperatorApprovalSessionEventRuntime({
    clients,
    sessionMessageSubscribers: subscribers,
    broadcastToConnIds: () => {},
  });
  const prepare = store.prepareOperatorApprovalReplay;
  const preparations = vi
    .spyOn(store, "prepareOperatorApprovalReplay")
    .mockImplementation(async (params) => {
      const result = await prepare(params);
      runtime.publish({ phase: "pending", record: unrelated });
      return result;
    });
  const context = {
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
    subscribeSessionMessageEvents: subscribers.subscribe,
    listSessionPendingApprovals: runtime.replay,
    logGateway: { error: vi.fn() },
  } as unknown as GatewayRequestContext;
  for (let round = 0; round < 2; round += 1) {
    const responses = await Promise.all(
      clients.map(async (client) => {
        const respond = vi.fn();
        await sessionSubscriptionHandlers["sessions.messages.subscribe"]!({
          req: { type: "req", id: "perf", method: "sessions.messages.subscribe" },
          params: { key: sessionKey, includeApprovals: true },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
        } satisfies GatewayRequestHandlerOptions);
        return respond;
      }),
    );
    for (const respond of responses) {
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        {
          subscribed: true,
          key: sessionKey,
          agentId: "main",
          approvalReplay: {
            sessionKey,
            updatedAtMs: 5000,
            approvals: expected,
            truncated: false,
          },
        },
        undefined,
      );
    }
    expect(preparations).toHaveBeenCalledTimes(1);
  }
});
