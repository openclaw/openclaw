import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  withOpenClawTestState,
  type OpenClawTestState as State,
} from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  ensureSessionEntrySync as ensureEntry,
  loadSessionEntry,
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  type SessionTranscriptRuntimeTarget as Target,
} from "./session-accessor.js";
import {
  appendTranscriptEventSync as appendEvent,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { OwnedSessionTranscriptWriteContext as Context } from "./transcript-write-context-store.js";
import {
  bindOwnedSessionTranscriptWrites as bindWrites,
  captureOwnedTranscriptWriteAssertion as captureGuard,
  captureSessionTranscriptSourcePublication as capturePublisher,
  getOwnedSessionTranscriptInitialWriter as initialWriterFor,
  getOwnedSessionTranscriptWriterFence as writerFence,
  type InitialSessionTranscriptWriter,
  SessionTranscriptWriterClaimReboundError as ReboundError,
  withOwnedSessionTranscriptWrites as withWrites,
  withSessionTranscriptSourcePublication as withPublication,
} from "./transcript-write-context.js";

function makeTarget(storePath: string, sessionId = "owned-session") {
  return { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
}
function withWriteTarget<A extends unknown[]>(
  run: (target: Target, state: State, ...args: A) => Promise<void>,
) {
  return (...args: A) =>
    withOpenClawTestState(
      { label: "owned-transcript-commit", scenario: "minimal" },
      async (state) => {
        setRuntimeConfigSnapshot({});
        await run(makeTarget(path.join(state.agentDir(), "openclaw-agent.sqlite")), state, ...args);
      },
    );
}

const withTranscriptWrite: Context["withTranscriptWrite"] = async (run) => await run();
type OwnerOptions = Omit<Context, "sessionTarget" | "withTranscriptWrite">;
function owner(sessionTarget: Context["sessionTarget"], options: OwnerOptions = {}) {
  return { sessionTarget, withTranscriptWrite, ...options };
}
function revocableOwner(target: Context["sessionTarget"]) {
  const controller = new AbortController();
  const assertCommitAllowed = () => controller.signal.throwIfAborted();
  return { controller, context: owner(target, { assertCommitAllowed }) };
}
function seed(target: Target) {
  replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
}
const userMessage = { role: "user", content: "retained committed input" };
const mutations: Array<[string, (target: Target) => unknown]> = [
  [
    "header identity",
    (target) => ensureEntry(target, { sessionId: target.sessionId, updatedAt: 2 }),
  ],
  ["transcript replacement", (target) => replaceTranscriptEventsSync(target, [])],
  ["event append", (target) => appendEvent(target, { type: "custom", id: "late-event" })],
  ["message append", (target) => appendTranscriptMessageSync(target, { message: userMessage })],
];
type MutationCase = { write: (target: Target) => unknown; rebound: boolean };

it.each([false, true])(
  "settles committed transcript publication when source binding throws (native=%s)",
  withWriteTarget(async (target, _state, native: boolean) => {
    seed(target);
    const committed = vi.fn();
    const failure = new Error("source binding refused after commit");
    await expect(
      withPublication(
        target,
        () => {
          throw failure;
        },
        () =>
          persistSessionTranscriptTurn(target, {
            expectedSessionId: target.sessionId,
            messages: [
              {
                message: userMessage,
                ...(native
                  ? { prepareMessageAfterIdempotencyCheck: (message: unknown) => message }
                  : {}),
              },
            ],
            onMessageCommitted: committed,
          }),
      ),
    ).rejects.toBe(failure);
    expect(committed).toHaveBeenCalledOnce();
    expect(loadTranscriptEventsSync(target)).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ content: userMessage.content }),
      }),
    );
  }),
);

it("revokes the captured source publisher when its initiating write scope settles", async () => {
  const target = makeTarget("/isolated/source.sqlite", "source-session");
  const publish = vi.fn();
  let captured: ReturnType<typeof capturePublisher>;
  await withPublication(target, publish, async () => {
    expect(capturePublisher({ ...target, sessionId: "another-session" })).toBeUndefined();
    captured = capturePublisher(target);
    expect(captured).toBeTypeOf("function");
    expect(capturePublisher(target)).toBeUndefined();
  });
  captured?.(
    { agentId: "main", path: target.storePath, databaseIdentity: "retired-source" },
    { sessionId: target.sessionId, updatedAt: 1 },
  );
  expect(publish).not.toHaveBeenCalled();
});
it.each(
  mutations.flatMap(([name, write]) => [false, true].map((rebound) => ({ name, write, rebound }))),
)(
  "rejects revoked/rebound authority at $name (rebound=$rebound)",
  withWriteTarget(async (target, _state, { write, rebound }: MutationCase) => {
    const writeTarget = rebound ? { ...target, sessionId: "other-session" } : target;
    if (rebound) {
      seed(writeTarget);
      appendEvent(writeTarget, { type: "custom", id: "original" });
    }
    const before = rebound ? loadTranscriptEventsSync(writeTarget) : [];
    const revoked = new Error("owner closed before commit");
    await withWrites(
      owner(target, {
        assertCommitAllowed: () => {
          if (!rebound) {
            throw revoked;
          }
        },
      }),
      async () => {
        expect(() => write(writeTarget)).toThrow(rebound ? ReboundError : revoked);
      },
    );
    expect(loadSessionEntry(writeTarget)).toEqual(
      rebound ? expect.objectContaining({ updatedAt: 1 }) : undefined,
    );
    expect(loadTranscriptEventsSync(writeTarget)).toEqual(before);
  }),
);

it.each([false, true])(
  "checks owner after synchronous message preparation (revoke=%s)",
  withWriteTarget(async (target, _state, revoke: boolean) => {
    seed(target);
    const { controller, context } = revocableOwner(target);
    const revoked = new Error("owner closed in message preparation");
    await withWrites(context, async () => {
      const write = () =>
        appendTranscriptMessageSync(target, {
          message: { role: "user", content: "prepared" },
          prepareMessageAfterIdempotencyCheck: (message) => {
            if (revoke) {
              controller.abort(revoked);
            }
            return message;
          },
        });
      if (revoke) {
        expect(write).toThrow(revoked);
      } else {
        expect(write()).toMatchObject({ ok: true, value: { appended: true } });
      }
    });
    expect(loadTranscriptEventsSync(target)).toHaveLength(revoke ? 0 : 2);
    expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
  }),
);

const runningTarget = {
  ...makeTarget("/state/agents/main/openclaw-agent.sqlite", "running"),
  expectedLifecycleRevision: "rev-3",
  expectedWriterRunId: "run-running",
};

it("scopes writer fences to matching keys and targets while retaining the ambient lookup", async () => {
  const fence = { expectedLifecycleRevision: "rev-3", expectedWriterRunId: "run-running" };
  const cases: Array<[Parameters<typeof writerFence>[0], boolean]> = [
    [{ sessionKey: runningTarget.sessionKey }, true],
    [{ sessionKey: "agent:main:elsewhere" }, false],
    [{ sessionTarget: runningTarget }, true],
    [{ sessionTarget: { ...runningTarget, storePath: "/different.sqlite" } }, false],
    [undefined, true],
  ];
  await withWrites(owner(runningTarget, { sessionKey: runningTarget.sessionKey }), async () => {
    for (const [request, allowed] of cases) {
      expect(writerFence(request)).toEqual(allowed ? fence : undefined);
    }
  });
  expect(writerFence()).toBeUndefined();
});

it.each(["withOwned", "bindOwned"] as const)(
  "retains the admitted environment across a queued assertion from %s",
  withWriteTarget(async (target, state, entry: "withOwned" | "bindOwned") => {
    const rootA = { OPENCLAW_STATE_DIR: state.stateDir, OPENCLAW_SUPERVISOR_MODE: "external" };
    const rootB = { ...rootA, OPENCLAW_STATE_DIR: state.path("other-state") };
    const callerEnv: NodeJS.ProcessEnv = { ...rootA };
    const requestedEnv: NodeJS.ProcessEnv = { ...rootA };
    const { controller, context } = revocableOwner({ ...target, env: callerEnv });
    const captureAssertions = () => ({
      admitted: captureGuard({ ...target, env: requestedEnv }),
      otherRoot: captureGuard({ ...target, env: rootB }),
      otherSupervisor: captureGuard({ ...target, env: { OPENCLAW_STATE_DIR: state.stateDir } }),
    });
    const changeOwnerEnvironment = () => {
      callerEnv.OPENCLAW_STATE_DIR = rootB.OPENCLAW_STATE_DIR;
      delete callerEnv.OPENCLAW_SUPERVISOR_MODE;
      state.envVars.OPENCLAW_STATE_DIR = rootB.OPENCLAW_STATE_DIR;
      state.envVars.OPENCLAW_SUPERVISOR_MODE = undefined;
      state.applyEnv();
    };
    const retained = await (async () => {
      if (entry === "withOwned") {
        return await withWrites(context, async () => {
          changeOwnerEnvironment();
          return captureAssertions();
        });
      }
      const bound = bindWrites(context, captureAssertions);
      changeOwnerEnvironment();
      return await Promise.resolve().then(bound);
    })();
    requestedEnv.OPENCLAW_STATE_DIR = rootB.OPENCLAW_STATE_DIR;
    delete requestedEnv.OPENCLAW_SUPERVISOR_MODE;
    await Promise.resolve();
    expect(retained.admitted).not.toThrow();
    expect.soft(retained.otherRoot).toThrow(ReboundError);
    expect.soft(retained.otherSupervisor).toThrow(ReboundError);
    const revoked = new Error("original owner revoked after the async handoff");
    controller.abort(revoked);
    expect(retained.admitted).toThrow(revoked);
  }),
);

it.each([false, true])(
  "keeps partial-ID fence matching inside the captured environment (partial owner=%s)",
  withWriteTarget(async (target, state, partialOwner: boolean) => {
    const env = { OPENCLAW_STATE_DIR: state.stateDir };
    const fullTarget = { ...target, env };
    const partialTarget = { sessionKey: target.sessionKey, storePath: target.storePath, env };
    const fence = { expectedLifecycleRevision: "env-revision", expectedWriterRunId: "env-run" };
    await withWrites(
      owner({ ...(partialOwner ? partialTarget : fullTarget), ...fence }),
      async () => {
        const request = partialOwner ? fullTarget : partialTarget;
        expect(writerFence({ sessionTarget: request })).toEqual(fence);
        const otherRoot = {
          ...request,
          env: { OPENCLAW_STATE_DIR: state.path("other-state") },
        };
        expect(writerFence({ sessionTarget: otherRoot })).toBeUndefined();
      },
    );
  }),
);

it(
  "keeps the original initial writer only for its captured storage environment",
  withWriteTarget(async (target, state) => {
    const scoped = { ...target, env: { OPENCLAW_STATE_DIR: state.stateDir } };
    const initialWriter: InitialSessionTranscriptWriter = {
      writerRunId: "initial-environment-run",
      committedFence: undefined,
      assertActive: () => {},
      recordCommitted: () => {},
      withTranscriptWrite,
    };
    await withWrites(owner(scoped, { initialWriter }), async () => {
      expect(initialWriterFor({ sessionTarget: scoped })).toBe(initialWriter);
      const otherRoot = { ...scoped, env: { OPENCLAW_STATE_DIR: state.path("other-state") } };
      expect(() => initialWriterFor({ sessionTarget: otherRoot })).toThrow(ReboundError);
    });
  }),
);
