import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { recordSessionCreated } from "./session-created.js";
import {
  recordSessionCompacted,
  recordSessionGoalChanged,
  recordSessionHumanDirectMessage,
  recordSessionStateEventAsync,
  recordSubagentSpawned,
} from "./session-state-events.js";
import type { SessionStateEventRow, SessionStateNotice } from "./session-state-events.kernel.js";

const edge = vi.hoisted(() => {
  const phases: string[] = [];
  const context = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    admission: {
      databasePath: "/synthetic/state.sqlite",
      coordinationKey: "captured-shared-state",
      identity: { key: "file:1:1", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent: vi.fn(),
    },
  } satisfies OpenClawStateWorkerContext;
  const execute = vi.fn<(command: { type: string; input: unknown }) => Promise<unknown>>();
  return {
    phases,
    context,
    execute,
    capture: vi.fn(() => context),
    admission: vi.fn((_admit: (request: { stage: string }, grant: () => boolean) => void) => ({})),
    run: vi.fn(
      async (
        _context: unknown,
        operation: (scope: { execute: typeof execute }) => Promise<unknown>,
        _options?: { createAdmission: () => unknown },
      ) => {
        const result = await operation({ execute });
        phases.push("settled");
        return result;
      },
    ),
    notice: vi.fn((_notice: unknown) => phases.push("notice")),
    warn: vi.fn(),
    forbidden: vi.fn((): never => {
      throw new Error("Session signal control crossed a native or process boundary");
    }),
    nativeTransaction: vi.fn((operation: (database: { db: object }) => unknown) =>
      operation({ db: {} }),
    ),
  };
});

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
vi.mock("../infra/sqlite-worker-operation-admission.js", () => ({
  createSqliteWorkerOperationAdmission: edge.admission,
}));
vi.mock("../infra/node-sqlite.js", () => ({
  requireNodeSqlite: edge.forbidden,
  openNodeSqliteDatabase: edge.forbidden,
}));
// Schema owners create query caches at import time; keep factories real and SQL calls forbidden.
vi.mock("../infra/kysely-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/kysely-sync.js")>()),
  getNodeSqliteKysely: edge.forbidden,
  executeSqliteQuerySync: edge.forbidden,
  executeSqliteQueryTakeFirstSync: edge.forbidden,
}));
// Keep config loading from publishing metadata readers that capture this fixture's native mocks.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../config/sessions/session-accessor.js", () => ({ loadSessionEntryReadOnly: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: edge.warn }),
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: edge.forbidden,
  runOpenClawStateWriteTransaction: edge.nativeTransaction,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: edge.capture,
  captureOpenClawStateReadWorkerContext: edge.capture,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: edge.run,
}));
// mock-isolation: Host-control proof forbids native SQL and substitutes only the worker result codec.
vi.mock("./session-state-events.kernel.js", () => ({
  rowToSessionStateEvent: vi.fn(),
}));
vi.mock("./session-state-notices.js", () => ({ enqueueSessionStateNotice: edge.notice }));

const notice: SessionStateNotice = {
  watcherSessionKey: "agent:main:main",
  watcherStorePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
  targetSessionKey: "agent:main:child",
  lastSeenSequence: 17,
  queueOnly: false,
};
const row: SessionStateEventRow = {
  sequence: 18,
  dedupe_key: null,
  session_key: "agent:main:child",
  session_id: "child-session",
  agent_id: "main",
  kind: "human_direct_message",
  actor_type: "human",
  actor_id: null,
  run_id: null,
  occurred_at: 1,
  summary: "human message",
  payload_json: null,
};
type Recorded = { row?: SessionStateEventRow; notices: SessionStateNotice[] };
let now = 4_000_000;

function goalChange() {
  return recordSessionGoalChanged({
    sessionKey: "global",
    agentId: "ops",
    entry: {
      sessionId: "original-session",
      updatedAt: 1,
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:other-parent",
    },
    actor: { type: "human", id: "operator" },
    summary: "goal complete",
  });
}

function recordSibling() {
  return recordSessionStateEventAsync({
    sessionKey: "agent:main:sibling",
    agentId: "main",
    kind: "adopted",
    actorType: "system",
    summary: "session adopted",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  edge.phases.length = 0;
  edge.capture.mockImplementation(() => edge.context);
  edge.execute.mockImplementation(async (command) => {
    edge.phases.push(command.type === "sessionState.prune" ? "prune" : "record");
    return command.type === "sessionState.prune" ? undefined : { row, notices: [notice] };
  });
  edge.notice.mockImplementation(() => edge.phases.push("notice"));
  edge.warn.mockImplementation(() => undefined);
  now += 4_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
});

afterEach(() => {
  expect(edge.forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("Session signal worker reconciliation", () => {
  it.each(["transaction", "commit"])(
    "refuses a revoked producer at %s admission",
    async (stage) => {
      const recorded = createDeferred<Recorded>();
      edge.execute.mockReturnValueOnce(recorded.promise);
      let current = true;
      const pending = recordSessionStateEventAsync(
        {
          sessionKey: "agent:main:child",
          agentId: "main",
          kind: "human_direct_message",
          actorType: "human",
          summary: "human message",
        },
        {
          assertCurrent: () => {
            if (!current) {
              throw new Error("producer retired");
            }
          },
        },
      );
      edge.run.mock.calls.at(-1)![2]!.createAdmission();
      const admit = edge.admission.mock.calls.at(-1)![0];
      current = false;
      const grant = vi.fn(() => true);
      expect(() => admit({ stage }, grant)).toThrow("producer retired");
      expect(grant).not.toHaveBeenCalled();
      recorded.reject(new Error("producer retired"));
      await expect(pending).resolves.toBeUndefined();
      expect(edge.notice).not.toHaveBeenCalled();
    },
  );

  it("keeps watched human-turn recording off the main-thread transaction owner", async () => {
    const recorded = createDeferred<Recorded>();
    edge.execute.mockReturnValueOnce(recorded.promise);
    let settled = false;
    const pending = Promise.resolve(
      recordSessionHumanDirectMessage({
        sessionKey: "agent:main:child",
        entry: { sessionId: "child-session", updatedAt: now, spawnedBy: "agent:main:main" },
        actor: { actorType: "human" },
        channel: "webchat",
      }),
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(edge.nativeTransaction).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(edge.notice).not.toHaveBeenCalled();
    recorded.resolve({ row, notices: [notice] });
    await pending;
    expect(edge.notice).toHaveBeenCalledWith(notice);
    expect(settled).toBe(true);
  });

  it("retains committed notices and pruning before producer settlement", async () => {
    const recorded = createDeferred<Recorded>();
    const recordStarted = createDeferred();
    const pruning = createDeferred();
    const pruneStarted = createDeferred();
    edge.execute.mockImplementation(async (command) => {
      if (command.type === "sessionState.prune") {
        edge.phases.push("prune");
        pruneStarted.resolve();
        return pruning.promise;
      }
      edge.phases.push("record");
      recordStarted.resolve();
      return recorded.promise;
    });
    let returned = false;
    const pending = goalChange().then(() => {
      returned = true;
    });
    await recordStarted.promise;
    expect(edge.notice).not.toHaveBeenCalled();
    expect(returned).toBe(false);
    expect(edge.execute).toHaveBeenCalledWith({
      type: "sessionState.record",
      input: {
        now,
        onlyIfWatched: undefined,
        expectedUpstream: undefined,
        event: {
          sessionKey: "global",
          sessionId: "original-session",
          agentId: "ops",
          kind: "goal_changed",
          actorType: "human",
          actorId: "operator",
          summary: "goal complete",
          watcherSessionKeys: ["agent:main:main"],
          watcherStorePaths: { "agent:main:main": notice.watcherStorePath },
        },
      },
    });
    recorded.resolve({ row, notices: [notice] });
    await pruneStarted.promise;
    expect(edge.phases).toEqual(["record", "notice", "prune"]);
    expect(returned).toBe(false);
    expect(edge.run.mock.calls[0]?.[0]).toBe(edge.context);
    expect(edge.nativeTransaction).not.toHaveBeenCalled();
    pruning.resolve();
    await pending;
    expect(edge.phases).toEqual(["record", "notice", "prune", "settled"]);
    expect(returned).toBe(true);
  });

  it.each(["capture", "unknown-outcome", "notice", "prune", "logger"] as const)(
    "preserves the originating committed result after %s failure without replay",
    async (failure) => {
      const error = Object.assign(new Error("Synthetic event failure"), {
        code: "outcome-unknown",
      });
      if (failure === "capture") {
        edge.capture.mockImplementationOnce(() => {
          throw error;
        });
      } else if (failure === "notice") {
        edge.notice.mockImplementationOnce(() => {
          throw error;
        });
      } else if (failure === "prune") {
        edge.execute.mockImplementation(async (command) => {
          if (command.type === "sessionState.prune") {
            throw error;
          }
          return { row, notices: [notice] };
        });
      } else {
        edge.execute.mockRejectedValueOnce(error);
        if (failure === "logger") {
          edge.warn.mockImplementationOnce(() => {
            throw new Error("Synthetic diagnostic sink failure");
          });
        }
      }
      await expect(goalChange()).resolves.toBeUndefined();
      expect(
        edge.execute.mock.calls.filter(([command]) => command.type === "sessionState.record"),
      ).toHaveLength(failure === "capture" ? 0 : 1);
      expect(edge.warn).toHaveBeenCalled();
      expect(edge.nativeTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("releases a pending prune reservation after failure=%s", async (fail) => {
    const pruning = createDeferred();
    const pruneStarted = createDeferred();
    const nextPruneStarted = createDeferred();
    let prunes = 0;
    edge.execute.mockImplementation(async (command) => {
      if (command.type === "sessionState.prune") {
        if (++prunes === 2) {
          nextPruneStarted.resolve();
          return;
        }
        pruneStarted.resolve();
        return pruning.promise;
      }
      return { row, notices: [] };
    });
    const pending = goalChange();
    await pruneStarted.promise;
    await recordSibling();
    if (fail) {
      pruning.reject(new Error("Synthetic prune refusal"));
    } else {
      pruning.resolve();
    }
    await pending;
    if (!fail) {
      now += 4_000_000;
      vi.mocked(Date.now).mockReturnValue(now);
    }
    const next = recordSibling();
    await nextPruneStarted.promise;
    await next;
    expect(
      edge.execute.mock.calls.filter(([command]) => command.type === "sessionState.prune"),
    ).toHaveLength(2);
  });

  it.each([
    [
      "creation",
      () =>
        recordSessionCreated(
          {},
          {
            sessionKey: "agent:main:main",
            entry: { sessionId: "created", updatedAt: 1, createdActor: { type: "system" } },
          },
        ),
    ],
    [
      "compaction",
      () => recordSessionCompacted({ sessionKey: "agent:main:child", operationId: "compact" }),
    ],
    [
      "spawn",
      () =>
        recordSubagentSpawned({
          childSessionKey: "agent:main:child",
          childRunId: "spawn",
          requesterSessionKey: "agent:main:main",
          agentId: "main",
        }),
    ],
  ] as const)("settles %s once after an unknown signal outcome", async (_name, record) => {
    edge.execute.mockRejectedValueOnce(
      Object.assign(new Error("Synthetic lost signal reply"), {
        code: "outcome-unknown",
      }),
    );
    await expect(record()).resolves.toBeUndefined();
    expect(edge.execute).toHaveBeenCalledTimes(1);
    expect(edge.nativeTransaction).not.toHaveBeenCalled();
    expect(edge.notice).not.toHaveBeenCalled();
  });
});
