// A run admitted from inside another run's transcript owner starts without it: an
// in-process caller (a parent's tool launching a child) must not lend its writer claim.
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  assertOwnedTranscriptWriteCommit,
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  describe0AfterEach0,
  getAgentTestMocks,
  invokeAgent,
  primeMainAgentRun,
  type AgentCommandCall,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

const CHILD_SESSION_KEY = "agent:main:main";
const STORE_PATH = "/tmp/sessions.json";
const PARENT_TARGET = {
  agentId: "main",
  sessionId: "parent-session",
  sessionKey: "agent:main:dashboard:parent",
  storePath: STORE_PATH,
};

type ChildObservation = {
  ambientFence: ReturnType<typeof getOwnedSessionTranscriptWriterFence>;
  openError: unknown;
  ownFence: ReturnType<typeof getOwnedSessionTranscriptWriterFence>;
  crossWriteError: unknown;
  parentPostCommitError: unknown;
};

function caught(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The parent's embedded attempt: a live writer claim on its own transcript. */
function asParentRun<T>(isCurrent: () => boolean, run: () => Promise<T>): Promise<T> {
  return withOwnedSessionTranscriptWrites(
    {
      sessionKey: PARENT_TARGET.sessionKey,
      sessionTarget: { ...PARENT_TARGET, expectedWriterRunId: "parent-run" },
      assertCommitAllowed: () => {
        if (!isCurrent()) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
      },
      withTranscriptWrite: trackAsyncWork,
    },
    run,
  );
}

/** What the child's turn does with its own transcript, recorded where the child runs. */
async function observeChildRun(
  opts: AgentCommandCall,
  parentPostCommit: () => void,
): Promise<ChildObservation> {
  const childTarget = {
    agentId: "main",
    sessionId: String(opts.sessionId),
    sessionKey: String(opts.sessionKey),
    storePath: STORE_PATH,
  };
  const ambientFence = getOwnedSessionTranscriptWriterFence();
  // The first check SessionManager.openAsync makes when post-turn CLI compaction opens it.
  const openError = caught(captureOwnedTranscriptWriteAssertion(childTarget));
  // Once the child claims its transcript, its own fence applies and foreign writes stay refused.
  const ownRun = await withOwnedSessionTranscriptWrites(
    {
      sessionKey: childTarget.sessionKey,
      sessionTarget: { ...childTarget, expectedWriterRunId: "child-run" },
      assertCommitAllowed: () => {},
      withTranscriptWrite: trackAsyncWork,
    },
    async () => ({
      ownFence: getOwnedSessionTranscriptWriterFence({ sessionTarget: childTarget }),
      crossWriteError: caught(() => assertOwnedTranscriptWriteCommit(PARENT_TARGET)),
    }),
  );
  return { ambientFence, openError, ...ownRun, parentPostCommitError: caught(parentPostCommit) };
}

async function admitChild(idempotencyKey: string) {
  const respond = await invokeAgent({
    message: "child task",
    agentId: "main",
    sessionKey: CHILD_SESSION_KEY,
    idempotencyKey,
  });
  expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0])).toBe(true);
  expect(mocks.agentCommand).toHaveBeenCalled();
}

function expectDetachedChild(observed: ChildObservation) {
  expect(observed.openError).toBeUndefined();
  expect(observed.ambientFence).toBeUndefined();
  expect(observed.ownFence).toEqual({
    expectedLifecycleRevision: undefined,
    expectedWriterRunId: "child-run",
  });
  expect(observed.crossWriteError).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
  expect(observed.parentPostCommitError).toBeUndefined();
}

describe("gateway agent run admitted inside a foreign transcript owner", () => {
  afterEach(describe0AfterEach0);

  it("starts an idle child run without the parent's writer claim", async () => {
    primeMainAgentRun({ sessionId: "child-session" });
    const child = createDeferredCore<ChildObservation>();
    await asParentRun(
      () => true,
      async () => {
        const parentPostCommit = captureOwnedTranscriptWriteAssertion(PARENT_TARGET);
        mocks.agentCommand.mockImplementation(async (opts: AgentCommandCall) => {
          child.resolve(await observeChildRun(opts, parentPostCommit));
          return { payloads: [{ text: "ok" }], meta: { durationMs: 1 } };
        });
        await admitChild("foreign-owner-idle");
      },
    );
    expectDetachedChild(await child.promise);
  });

  it("starts a child queued behind its busy session without the parent's writer claim", async () => {
    primeMainAgentRun({ sessionId: "child-session" });
    const lane = resolveSessionLane(CHILD_SESSION_KEY);
    const busy = createDeferredCore();
    // The child session's own run holds its lane when the parent launches the child.
    const busyRun = enqueueCommandInLane(lane, () => busy.promise, { maxConcurrent: 1 });
    const child = createDeferredCore<ChildObservation>();
    let childStarted = false;
    await asParentRun(
      () => true,
      async () => {
        const parentPostCommit = captureOwnedTranscriptWriteAssertion(PARENT_TARGET);
        mocks.agentCommand.mockImplementation(async (opts: AgentCommandCall) => {
          await enqueueCommandInLane(lane, async () => {
            childStarted = true;
            child.resolve(await observeChildRun(opts, parentPostCommit));
          });
          return { payloads: [{ text: "ok" }], meta: { durationMs: 1 } };
        });
        await admitChild("foreign-owner-queued");
      },
    );
    expect(childStarted).toBe(false);
    busy.resolve();
    await busyRun;
    expectDetachedChild(await child.promise);
  });

  it("keeps the parent's claim and still rejects its stale writer after the child is admitted", async () => {
    primeMainAgentRun({ sessionId: "child-session" });
    let parentWriterCurrent = true;
    const child = createDeferredCore<ChildObservation>();
    const parentAfterAdmission = await asParentRun(
      () => parentWriterCurrent,
      async () => {
        const parentPostCommit = captureOwnedTranscriptWriteAssertion(PARENT_TARGET);
        mocks.agentCommand.mockImplementation(async (opts: AgentCommandCall) => {
          // The parent's writer is replaced while its child runs.
          parentWriterCurrent = false;
          child.resolve(await observeChildRun(opts, parentPostCommit));
          return { payloads: [{ text: "ok" }], meta: { durationMs: 1 } };
        });
        await admitChild("foreign-owner-stale-parent");
        await child.promise;
        return {
          fence: getOwnedSessionTranscriptWriterFence({ sessionTarget: PARENT_TARGET }),
          ownWriteError: caught(() => assertOwnedTranscriptWriteCommit(PARENT_TARGET)),
          childWriteError: caught(() =>
            assertOwnedTranscriptWriteCommit({
              agentId: "main",
              sessionId: "child-session",
              sessionKey: CHILD_SESSION_KEY,
              storePath: STORE_PATH,
            }),
          ),
        };
      },
    );
    const observed = await child.promise;
    // Detaching the child never launders the parent's captured post-commit work.
    expect(observed.openError).toBeUndefined();
    expect(observed.ambientFence).toBeUndefined();
    expect(observed.parentPostCommitError).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
    // Back in the parent its own claim is intact: fenced, stale-checked and target-bound.
    expect(parentAfterAdmission.fence).toEqual({
      expectedLifecycleRevision: undefined,
      expectedWriterRunId: "parent-run",
    });
    expect(parentAfterAdmission.ownWriteError).toBeInstanceOf(
      SessionTranscriptWriterClaimReboundError,
    );
    expect(parentAfterAdmission.childWriteError).toBeInstanceOf(
      SessionTranscriptWriterClaimReboundError,
    );
  });
});
