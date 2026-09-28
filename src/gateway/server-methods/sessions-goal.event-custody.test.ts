import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { sessionGoalHandlers } from "./sessions-goal.js";
import type { GatewayRequestContext } from "./types.js";

const edge = vi.hoisted(() => ({
  mutate: vi.fn(),
  record: vi.fn(),
  emit: vi.fn(),
  current: vi.fn(),
  forbidden: vi.fn((): never => {
    throw new Error("Pure Goal RPC control crossed a native or process boundary");
  }),
  target: {
    agentId: "main",
    storePath: "/synthetic/agents/main/sessions.json",
    storeKey: "agent:main:goal",
    canonicalKey: "agent:main:goal",
    entry: { sessionId: "goal-session", lifecycleRevision: "original", updatedAt: 1 },
  },
}));

vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:worker_threads", () => ({ isMainThread: true, threadId: 0, Worker: edge.forbidden }));
vi.mock("node:child_process", () => ({
  spawn: edge.forbidden,
  spawnSync: edge.forbidden,
  exec: edge.forbidden,
  execSync: edge.forbidden,
  execFile: edge.forbidden,
  execFileSync: edge.forbidden,
  fork: edge.forbidden,
}));
vi.mock("../../infra/node-sqlite.js", () => ({
  requireNodeSqlite: edge.forbidden,
  openNodeSqliteDatabase: edge.forbidden,
}));
vi.mock("../../infra/kysely-sync.js", () => ({
  getNodeSqliteKysely: edge.forbidden,
  executeSqliteQuerySync: edge.forbidden,
  executeSqliteQueryTakeFirstSync: edge.forbidden,
}));
vi.mock("../../../packages/gateway-protocol/src/index.js", () => ({
  ErrorCodes: { INVALID_REQUEST: "INVALID_REQUEST", UNAVAILABLE: "UNAVAILABLE" },
  errorShape: (code: string, message: string) => ({ code, message }),
  validateSessionsGoalClearParams: () => true,
  validateSessionsGoalUpdateParams: () => true,
}));
vi.mock("../../config/sessions/goals-operations.js", () => ({
  mutateSessionGoal: edge.mutate,
  SessionGoalOperationError: class extends Error {},
}));
vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionGoalChanged: edge.record,
}));
vi.mock("../session-plugin-ownership.js", () => ({
  resolvePluginSessionOwnershipError: () => null,
}));
vi.mock("../session-request-agent.js", () => ({
  resolveRequestedSessionAgentId: () => ({ ok: true, agentId: "main" }),
}));
vi.mock("../session-sharing.js", () => ({
  resolveSessionMutationAuthorization: () => ({
    authorization: { assertCurrent: edge.current },
    error: null,
  }),
  resolveSessionSharingTarget: () => edge.target,
  SessionMutationAuthorizationChangedError: class extends Error {},
}));
vi.mock("./gateway-client-identity.js", () => ({
  gatewayClientSessionCreator: () => ({ type: "human", id: "operator" }),
}));
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: edge.emit }));
vi.mock("./session-goal-request.js", () => ({
  fingerprintSessionGoalRequest: () => "fingerprint",
}));

function invoke() {
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  const handler = sessionGoalHandlers["sessions.goal.update"];
  if (!handler) {
    throw new Error("Goal update handler is not registered");
  }
  const pending = handler({
    req: { type: "req", id: "goal-request", method: "sessions.goal.update" },
    params: {
      sessionKey: edge.target.canonicalKey,
      sessionId: edge.target.entry.sessionId,
      goalId: "goal-id",
      action: "complete",
      operationId: "operation-id",
      issuedAtMs: 1,
    },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  return { pending, respond };
}

beforeEach(() => {
  vi.clearAllMocks();
  edge.record.mockResolvedValue(undefined);
  edge.emit.mockImplementation(() => undefined);
  edge.mutate.mockResolvedValue({
    replayed: false,
    sessionEntry: edge.target.entry,
    result: { operationId: "operation-id", status: "updated" },
  });
});

afterEach(() => expect(edge.forbidden).not.toHaveBeenCalled());

describe("Goal RPC event custody", () => {
  it.each([false, true])(
    "publishes the committed projection immediately and joins event custody when broadcast fails=%s",
    async (broadcastFails) => {
      const committed = createDeferred();
      const event = createDeferred();
      const emitted = createDeferred();
      const order: string[] = [];
      edge.mutate.mockImplementation(async () => {
        await committed.promise;
        order.push("commit");
        return {
          replayed: false,
          sessionEntry: edge.target.entry,
          result: { operationId: "operation-id", status: "updated" },
        };
      });
      edge.record.mockImplementation(() => {
        order.push("event-start");
        return event.promise;
      });
      edge.emit.mockImplementation(() => {
        order.push("projection");
        emitted.resolve();
        if (broadcastFails) {
          throw new Error("Synthetic broadcaster failure");
        }
      });
      const { pending, respond } = invoke();
      expect(edge.record).not.toHaveBeenCalled();
      expect(edge.emit).not.toHaveBeenCalled();
      committed.resolve();
      await emitted.promise;
      expect(order).toEqual(["commit", "event-start", "projection"]);
      expect(respond).not.toHaveBeenCalled();
      event.resolve();
      await pending;
      expect(respond).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(
        true,
        { operationId: "operation-id", status: "updated" },
        undefined,
      );
      expect(edge.record).toHaveBeenCalledOnce();
    },
  );

  it("replies to a durable replay without issuing another event or projection change", async () => {
    const result = { operationId: "operation-id", status: "updated" };
    edge.mutate.mockResolvedValue({ replayed: true, result });
    const { pending, respond } = invoke();
    await pending;
    expect(respond).toHaveBeenCalledWith(true, { ...result, replayed: true }, undefined);
    expect(edge.record).not.toHaveBeenCalled();
    expect(edge.emit).not.toHaveBeenCalled();
  });
});
