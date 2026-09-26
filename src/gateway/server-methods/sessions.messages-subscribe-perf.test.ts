import { performance } from "node:perf_hooks";
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
    cleanup();
  }),
);

it("shares prepared approval replay across three subscribers without changing its approvals", async () => {
  const databaseOptions = {
    env: { OPENCLAW_STATE_DIR: tempDirs.make("subscribe-approval-perf-") },
  };
  const sessionKey = "agent:main:perf";
  const expected: PendingApprovalSnapshot[] = [];
  for (let index = 0; index < 200; index += 1) {
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
    await store.insertOperatorApproval({
      databaseOptions,
      approval: {
        id,
        kind: "exec",
        runtimeEpoch: "synthetic-epoch",
        createdAtMs: 1000 + index,
        expiresAtMs: 60_000,
        source: { agentId: "main", sessionKey },
        audienceSessionKeys: [sessionKey],
        reviewerDeviceIds: ["reviewer"],
        presentation,
      },
    });
    expected.push({
      id,
      status: "pending",
      presentation,
      urlPath: `/approve/${id}`,
      createdAtMs: 1000 + index,
      expiresAtMs: 60_000,
      sourceSessionKey: sessionKey,
    });
  }
  const clients = Array.from({ length: 3 }, (_, index) => ({
    connId: `subscriber-${index}`,
    connect: { client: { id: "test" }, scopes: ["operator.admin"] },
  })) as GatewayClient[];
  const subscribers = createSessionMessageSubscriberRegistry();
  const runtime = createOperatorApprovalSessionEventRuntime({
    clients,
    sessionMessageSubscribers: subscribers,
    broadcastToConnIds: () => {},
    databaseOptions,
    now: () => 5000,
  });
  const phaseMs = { expiry: 0, pending: 0 };
  const expire = store.expireDueOperatorApprovals;
  const list = store.listPendingOperatorApprovals;
  const expiryReads = vi
    .spyOn(store, "expireDueOperatorApprovals")
    .mockImplementation(async (params) => {
      const start = performance.now();
      const result = await expire(params);
      phaseMs.expiry += performance.now() - start;
      return result;
    });
  const pendingReads = vi
    .spyOn(store, "listPendingOperatorApprovals")
    .mockImplementation(async (params) => {
      const start = performance.now();
      const result = await list(params);
      phaseMs.pending += performance.now() - start;
      return result;
    });
  const context = {
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    subscribeSessionMessageEvents: subscribers.subscribe,
    listSessionPendingApprovals: runtime.replay,
    logGateway: { error: vi.fn() },
  } as unknown as GatewayRequestContext;
  const samples: number[] = [];
  for (let round = 0; round < 31; round += 1) {
    const responses = await Promise.all(
      clients.map(async (client) => {
        const start = performance.now();
        let responseMs = 0;
        const respond = vi.fn(() => {
          responseMs = performance.now() - start;
        });
        await sessionSubscriptionHandlers["sessions.messages.subscribe"]!({
          req: { type: "req", id: "perf", method: "sessions.messages.subscribe" },
          params: { key: sessionKey, includeApprovals: true },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
        } satisfies GatewayRequestHandlerOptions);
        if (round > 0) {
          samples.push(responseMs);
        }
        return respond;
      }),
    );
    for (const respond of responses) {
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        {
          subscribed: true,
          key: sessionKey,
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
    if (round === 0) {
      expiryReads.mockClear();
      pendingReads.mockClear();
      phaseMs.expiry = 0;
      phaseMs.pending = 0;
    }
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      pendingApprovals: 200,
      concurrency: 3,
      samples: samples.length,
      p50Ms: samples[Math.floor(samples.length * 0.5)],
      p90Ms: samples[Math.floor(samples.length * 0.9)],
      pendingReadsPerSubscribe: pendingReads.mock.calls.length / samples.length,
      expiryCallsPerSubscribe: expiryReads.mock.calls.length / samples.length,
      phaseMsPerSubscribe: {
        expiry: phaseMs.expiry / samples.length,
        pending: phaseMs.pending / samples.length,
      },
    }),
  );
  expect(pendingReads.mock.calls.length).toBe(samples.length / clients.length);
  expect(expiryReads.mock.calls.length).toBe(samples.length / clients.length);
});
