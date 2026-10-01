import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  ensureSessionEntrySync,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
  type SessionTranscriptRuntimeTarget,
} from "./session-accessor.js";
import {
  bindOwnedSessionTranscriptWrites,
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  getOwnedSessionTranscriptWriterFence,
  type InitialSessionTranscriptWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";

async function withWriteTarget(
  run: (target: SessionTranscriptRuntimeTarget, state: OpenClawTestState) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "owned-transcript-commit", scenario: "minimal" },
    async (state) => {
      await run(
        {
          agentId: "main",
          sessionId: "owned-session",
          sessionKey: "agent:main:owned-transcript-commit",
          storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        },
        state,
      );
    },
  );
}

const mutations = [
  {
    name: "header identity",
    write: (target: SessionTranscriptRuntimeTarget) =>
      ensureSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 2 }),
  },
  {
    name: "transcript replacement",
    write: (target: SessionTranscriptRuntimeTarget) => replaceTranscriptEventsSync(target, []),
  },
  {
    name: "event append",
    write: (target: SessionTranscriptRuntimeTarget) =>
      appendTranscriptEventSync(target, { type: "custom", id: "late-event" }),
  },
  {
    name: "message append",
    write: (target: SessionTranscriptRuntimeTarget) =>
      appendTranscriptMessageSync(target, { message: { role: "user", content: "late" } }),
  },
];

describe("owned transcript commit boundary", () => {
  it.each(mutations)(
    "rejects a revoked owner at $name without a scalar writer",
    async ({ write }) => {
      await withWriteTarget(async (target) => {
        const revoked = new Error("owner closed before commit");
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: target,
            assertCommitAllowed: () => {
              throw revoked;
            },
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            expect(() => write(target)).toThrow(revoked);
          },
        );
        expect(loadSessionEntry(target)).toBeUndefined();
        expect(loadTranscriptEventsSync(target)).toEqual([]);
      });
    },
  );

  it.each(mutations)("rejects a different physical target at $name", async ({ write }) => {
    await withWriteTarget(async (target) => {
      const other = { ...target, sessionId: "other-session" };
      replaceSessionEntrySync(other, { sessionId: other.sessionId, updatedAt: 1 });
      appendTranscriptEventSync(other, { type: "custom", id: "original" });
      const before = loadTranscriptEventsSync(other);
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          assertCommitAllowed: () => {},
          withTranscriptWrite: async (run) => await run(),
        },
        async () => {
          expect(() => write(other)).toThrow(SessionTranscriptWriterClaimReboundError);
        },
      );
      expect(loadSessionEntry(other)?.updatedAt).toBe(1);
      expect(loadTranscriptEventsSync(other)).toEqual(before);
    });
  });

  it.each([false, true])(
    "checks owner after synchronous message preparation (revoke=%s)",
    async (revoke) => {
      await withWriteTarget(async (target) => {
        replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
        const controller = new AbortController();
        const revoked = new Error("owner closed in message preparation");
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: target,
            assertCommitAllowed: () => controller.signal.throwIfAborted(),
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
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
          },
        );
        expect(loadTranscriptEventsSync(target)).toHaveLength(revoke ? 0 : 2);
        expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
      });
    },
  );
});

describe("owned transcript writer fence scope", () => {
  const runningTarget = {
    agentId: "main",
    sessionKey: "agent:main:running",
    storePath: "/state/agents/main/openclaw-agent.sqlite",
    expectedLifecycleRevision: "rev-3",
    expectedWriterRunId: "run-running",
  };

  async function withRunningWriter(run: () => void): Promise<void> {
    await withOwnedSessionTranscriptWrites(
      {
        sessionKey: runningTarget.sessionKey,
        sessionTarget: runningTarget,
        withTranscriptWrite: async (operation) => await operation(),
      },
      async () => run(),
    );
  }

  it("inherits the fence for a caller that names the running session by key alone", async () => {
    await withRunningWriter(() => {
      expect(
        getOwnedSessionTranscriptWriterFence({ sessionKey: runningTarget.sessionKey }),
      ).toEqual({
        expectedLifecycleRevision: "rev-3",
        expectedWriterRunId: "run-running",
      });
    });
  });

  it("withholds the fence from a caller naming another session by key alone", async () => {
    await withRunningWriter(() => {
      // A key-only caller cannot form a target, so before this scoping it was refused by
      // the target comparison and fell back to the ambient claim - a claim about a
      // different session entirely.
      expect(
        getOwnedSessionTranscriptWriterFence({ sessionKey: "agent:main:elsewhere" }),
      ).toBeUndefined();
    });
  });

  it("still compares targets when the caller can express one", async () => {
    await withRunningWriter(() => {
      expect(getOwnedSessionTranscriptWriterFence({ sessionTarget: runningTarget })).toEqual({
        expectedLifecycleRevision: "rev-3",
        expectedWriterRunId: "run-running",
      });
      expect(
        getOwnedSessionTranscriptWriterFence({
          sessionTarget: {
            ...runningTarget,
            storePath: "/state/agents/other/openclaw-agent.sqlite",
          },
        }),
      ).toBeUndefined();
    });
  });

  it("keeps the unscoped lookup reading the ambient claim", async () => {
    await withRunningWriter(() => {
      expect(getOwnedSessionTranscriptWriterFence()).toEqual({
        expectedLifecycleRevision: "rev-3",
        expectedWriterRunId: "run-running",
      });
    });
    expect(getOwnedSessionTranscriptWriterFence()).toBeUndefined();
  });
});

describe("owned transcript storage environment", () => {
  it.each(["withOwned", "bindOwned"] as const)(
    "retains the admitted environment across a queued assertion from %s",
    async (entry) => {
      await withWriteTarget(async (target, state) => {
        const rootA = { OPENCLAW_STATE_DIR: state.stateDir, OPENCLAW_SUPERVISOR_MODE: "external" };
        const rootB = { ...rootA, OPENCLAW_STATE_DIR: state.path("other-state") };
        const callerEnv: NodeJS.ProcessEnv = { ...rootA };
        const requestedEnv: NodeJS.ProcessEnv = { ...rootA };
        const controller = new AbortController();
        const context = {
          sessionTarget: { ...target, env: callerEnv },
          assertCommitAllowed: () => controller.signal.throwIfAborted(),
          withTranscriptWrite: async <T>(run: () => Promise<T> | T) => await run(),
        };
        const requestedTarget = { ...target, env: requestedEnv };
        const otherRootTarget = { ...target, env: rootB };
        const otherSupervisorTarget = {
          ...target,
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        };
        const captureAssertions = () => ({
          admitted: captureOwnedTranscriptWriteAssertion(requestedTarget),
          otherRoot: captureOwnedTranscriptWriteAssertion(otherRootTarget),
          otherSupervisor: captureOwnedTranscriptWriteAssertion(otherSupervisorTarget),
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
            return await withOwnedSessionTranscriptWrites(context, async () => {
              changeOwnerEnvironment();
              return captureAssertions();
            });
          }
          const bound = bindOwnedSessionTranscriptWrites(context, captureAssertions);
          changeOwnerEnvironment();
          return await Promise.resolve().then(bound);
        })();
        requestedEnv.OPENCLAW_STATE_DIR = rootB.OPENCLAW_STATE_DIR;
        delete requestedEnv.OPENCLAW_SUPERVISOR_MODE;

        await Promise.resolve().then(() => {
          expect(retained.admitted).not.toThrow();
          expect.soft(retained.otherRoot).toThrow(SessionTranscriptWriterClaimReboundError);
          expect.soft(retained.otherSupervisor).toThrow(SessionTranscriptWriterClaimReboundError);
          const revoked = new Error("original owner revoked after the async handoff");
          controller.abort(revoked);
          expect(retained.admitted).toThrow(revoked);
        });
      });
    },
  );

  it.each([false, true])(
    "keeps partial-ID fence matching inside the captured environment (partial owner=%s)",
    async (partialOwner) => {
      await withWriteTarget(async (target, state) => {
        const env = { OPENCLAW_STATE_DIR: state.stateDir };
        const fullTarget = { ...target, env };
        const partialTarget = { sessionKey: target.sessionKey, storePath: target.storePath, env };
        const fence = { expectedLifecycleRevision: "env-revision", expectedWriterRunId: "env-run" };
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: { ...(partialOwner ? partialTarget : fullTarget), ...fence },
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            const request = partialOwner ? fullTarget : partialTarget;
            expect(getOwnedSessionTranscriptWriterFence({ sessionTarget: request })).toEqual(fence);
            const otherRoot = {
              ...request,
              env: { OPENCLAW_STATE_DIR: state.path("other-state") },
            };
            expect(
              getOwnedSessionTranscriptWriterFence({ sessionTarget: otherRoot }),
            ).toBeUndefined();
          },
        );
      });
    },
  );

  it("keeps the original initial writer only for its captured storage environment", async () => {
    await withWriteTarget(async (target, state) => {
      const scoped = { ...target, env: { OPENCLAW_STATE_DIR: state.stateDir } };
      const initialWriter: InitialSessionTranscriptWriter = {
        writerRunId: "initial-environment-run",
        committedFence: undefined,
        assertActive: () => {},
        recordCommitted: () => {},
        withTranscriptWrite: async (run) => await run(),
      };
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scoped,
          initialWriter,
          withTranscriptWrite: initialWriter.withTranscriptWrite,
        },
        async () => {
          expect(getOwnedSessionTranscriptInitialWriter({ sessionTarget: scoped })).toBe(
            initialWriter,
          );
          const otherRoot = { ...scoped, env: { OPENCLAW_STATE_DIR: state.path("other-state") } };
          expect(() =>
            getOwnedSessionTranscriptInitialWriter({ sessionTarget: otherRoot }),
          ).toThrow(SessionTranscriptWriterClaimReboundError);
        },
      );
    });
  });
});
