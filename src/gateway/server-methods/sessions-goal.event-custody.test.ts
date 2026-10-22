import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
vi.mock("node:child_process", () =>
  Object.fromEntries(
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => [
      name,
      edge.forbidden,
    ]),
  ),
);
vi.mock("../../infra/node-sqlite.js", () => ({
  requireNodeSqlite: edge.forbidden,
  openNodeSqliteDatabase: edge.forbidden,
}));
vi.mock("../../infra/kysely-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/kysely-sync.js")>()),
  getNodeSqliteKysely: edge.forbidden,
  executeSqliteQuerySync: edge.forbidden,
  executeSqliteQueryTakeFirstSync: edge.forbidden,
}));
vi.mock("../../config/sessions/goals-operations.js", () => ({
  mutateSessionGoal: edge.mutate,
  SessionGoalOperationError: class extends Error {},
}));
vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionGoalChanged: edge.record,
}));
vi.mock("../session-request-agent.js", () => ({
  resolveRequestedSessionAgentId: () => ({ ok: true, agentId: "main" }),
}));
// mock-isolation: Goal-event fixtures control the sharing target and its revocation during delivery.
vi.mock("../session-sharing.js", () => ({
  resolveSessionSharingTargetAsync: async () => edge.target,
  SessionMutationAuthorizationChangedError: class extends Error {
    constructor(public error: { code: string; message: string }) {
      super(error.message);
    }
  },
}));
// mock-isolation: Event delivery does not need routing configuration.
vi.mock("../session-sharing-preparation.js", () => ({
  captureSessionMutationRouting: () => () => {},
}));
// mock-isolation: Goal-event fixtures supply revocable authorization without loading sharing storage.
vi.mock("../session-sharing-authorization-async.js", () => ({
  resolveSessionMutationAuthorizationAsync: async () => ({
    authorization: { assertCurrent: edge.current },
    error: null,
  }),
}));
// mock-isolation: Goal-event tests retain fixture rows and explicitly revoke their custody.
vi.mock("../../config/sessions/session-entry-current-check.js", () => ({
  captureSessionEntryCurrentCheckAsyncInternal: async () => ({
    entry: edge.target.entry,
    source: edge.current,
    release() {},
  }),
}));
vi.mock("./gateway-client-identity.js", () => ({
  gatewayClientSessionCreator: () => ({ type: "human", id: "operator" }),
}));
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: edge.emit }));
// mock-isolation: Fingerprinting must not create a process device identity.
vi.mock("./session-goal-request.js", () => ({
  fingerprintSessionGoalRequest: () => "fingerprint",
}));

const result = () => ({ operationId: "operation-id", status: "updated" });

function invoke() {
  const respond = vi.fn();
  const pending = sessionGoalHandlers["sessions.goal.update"]!({
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
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext,
    client: null,
    isWebchatConnect: () => false,
  });
  return { pending, respond };
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => expect(edge.forbidden).not.toHaveBeenCalled());

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
      return { replayed: false, sessionEntry: edge.target.entry, result: result() };
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
    expect([edge.record, edge.emit].map((mock) => mock.mock.calls)).toEqual([[], []]);
    committed.resolve();
    await emitted.promise;
    expect(order).toEqual(["commit", "event-start", "projection"]);
    expect(respond).not.toHaveBeenCalled();
    event.resolve();
    await pending;
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, result(), undefined);
    expect(edge.record).toHaveBeenCalledOnce();
  },
);

it("replies to a durable replay without issuing another event or projection change", async () => {
  edge.mutate.mockResolvedValue({ replayed: true, result: result() });
  const { pending, respond } = invoke();
  await pending;
  expect(respond).toHaveBeenCalledWith(true, { ...result(), replayed: true }, undefined);
  expect([edge.record, edge.emit].map((mock) => mock.mock.calls)).toEqual([[], []]);
});
