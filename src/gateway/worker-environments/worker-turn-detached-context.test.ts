import { AsyncResource } from "node:async_hooks";
import type { AgentMessage, CustomMessage } from "@openclaw/agent-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import { FailoverError } from "../../agents/failover-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { toWorkerTranscriptMessage } from "../../worker/transcript-message.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { createCoordinatorTestService } from "./placement-dispatch-coordinator.test-support.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import { createTranscriptCommitIdentity } from "./transcript-commit.test-support.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { releaseClaimIfOwned } from "./worker-turn-admission.js";
import {
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  database,
  dispatchInitialWorkerPlacement,
  placements,
  readWorkerTurnTranscriptStorageRows as readRows,
  reconcileUnchangedLocalWorkspace,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
  type WorkerTurnLauncherOptions,
} from "./worker-turn-launcher.test-support.js";

function visible(messages: readonly { role?: string; content?: unknown }[]) {
  return messages.map(({ role, content }) => ({
    role,
    text: typeof content === "string" ? content : collectTextContentBlocks(content).join(""),
  }));
}

function seedPrevious() {
  const manager = SessionManager.open(sessionTarget);
  manager.appendMessage(user("previous request", 1));
  const previousLeafId = manager.appendMessage(assistant("previous answer", 2));
  return { manager, previousLeafId };
}

const user = (content: string, timestamp = 0) => makeAgentUserMessage({ content, timestamp });
const assistant = (text: string, timestamp = 0) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp });
const runtimeContext = (customType = "openclaw.runtime-context"): CustomMessage => ({
  role: "custom",
  customType,
  content: "runtime context",
  display: false,
  details:
    customType === "openclaw.system-update"
      ? { kind: "runtime-context", turnScoped: true }
      : { source: "openclaw-runtime-context", runtimeContextCarrier: true },
  timestamp: 1,
});
type ToolActivity = Array<Extract<AgentMessage, { role: "assistant" | "toolResult" }>>;
function toolActivity(id: string, text: string, isError = false): ToolActivity {
  return [
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id, name: "exec", arguments: { command: "effect-once" } }],
      stopReason: "toolUse",
    }),
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "exec",
      content: [{ type: "text", text }],
      isError,
      timestamp: 2,
    },
  ];
}

const prior = [
  { role: "user", text: "previous request" },
  { role: "assistant", text: "previous answer" },
];
const priorAtModelBoundary = [
  { role: "user", text: "[Thu 1970-01-01 00:00 UTC] previous request" },
  { role: "assistant", text: "previous answer" },
];

function recorder(excludeFromContext = false) {
  return createUserTurnTranscriptRecorder({
    target: { ...sessionTarget, sessionEntry: undefined },
    input: {
      text: "current request",
      idempotencyKey: "synthetic-current-user",
      ...(excludeFromContext ? { excludeFromContext: true } : {}),
    },
  });
}

let hasUnjoinedOwner = false;

async function launchProbe(
  runId: string,
  overrides: Partial<SessionPlacementTurnParams> = {},
  assertRunCurrent?: () => void,
  waitForInitialPlacement?: WorkerTurnLauncherOptions["waitForInitialPlacement"],
  onLaunch?: (
    request: Parameters<NonNullable<WorkerTurnTunnelHandle["launchTurn"]>>[0],
  ) => Promise<void>,
) {
  const input = {
    ...turn(runId),
    prompt: "current request",
    transcriptPrompt: "current request",
    ...overrides,
  };
  if (!waitForInitialPlacement && (await placements.getAsync(SESSION_ID))?.state !== "active") {
    await seedActivePlacement();
  }
  const deliberateStop = new Error("synthetic worker launch complete");
  let credentialCalls = 0;
  let tunnelCalls = 0;
  let launch: { baseLeafId: string | null; history: ReturnType<typeof visible> } | undefined;
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected virtual transport operation");
  };
  const tunnel = createWorkerTurnTunnel({
    runWorkspaceCommand: unexpected,
    syncWorkspace: unexpected,
    reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    launchTurn: async (request) => {
      const { plan } = request;
      launch = {
        baseLeafId: plan.assignment.transcript.baseLeafId,
        history: visible(plan.assignment.initialMessages),
      };
      await onLaunch?.(request);
      // Never call onDispatchReady: no remote turn or credential delivery occurs.
      throw deliberateStop;
    },
  });
  const environments: WorkerTurnEnvironmentService = {
    ...unusedEnvironments(),
    get: () => attachedEnvironment(),
    acquireTurnCredential: async () => {
      credentialCalls++;
      return credential();
    },
    acknowledgeCredentialDelivery: () => {
      throw new Error("fixture must not dispatch");
    },
    startTunnel: async () => {
      tunnelCalls++;
      return tunnel;
    },
    stopTunnel: async () => {},
    destroy: unexpected,
  };
  const provider = createWorkerSessionTurnPlacementProvider({
    environments,
    placements,
    ...(waitForInitialPlacement ? { waitForInitialPlacement } : {}),
  });
  hasUnjoinedOwner = true;
  const pending = provider
    .executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: input.runId },
      input,
      unexpected,
      undefined,
      assertRunCurrent,
    )
    .then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
  let outcome: Awaited<typeof pending>;
  try {
    outcome = await pending;
  } finally {
    hasUnjoinedOwner = false;
    input.preparedRunAdmission?.close();
  }
  expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
  if (launch && !onLaunch) {
    expect(outcome.kind === "rejected" && outcome.error).toBe(deliberateStop);
  }
  return { launch, credentialCalls, tunnelCalls, outcome };
}

function expectNoLaunch(result: Awaited<ReturnType<typeof launchProbe>>) {
  expect(result).toMatchObject({ credentialCalls: 0, tunnelCalls: 0, launch: undefined });
}

async function withAsyncReadHook<T>(
  hook: () => Promise<void>,
  run: () => Promise<T>,
  phase: "before" | "after" = "after",
) {
  const original = SessionManager.openModelContextAsync.bind(SessionManager);
  const read = vi
    .spyOn(SessionManager, "openModelContextAsync")
    .mockImplementation(async (...args) => {
      if (phase === "before") {
        await hook();
      }
      const result = await original(...args);
      if (phase === "after") {
        await hook();
      }
      return result;
    });
  try {
    return { result: await run(), calls: read.mock.calls.length };
  } finally {
    read.mockRestore();
  }
}

function afterNextModelContextSnapshot(afterSnapshot: () => Promise<void>) {
  // The concurrent writer must not borrow the reader's transcript admission fence.
  const mutate = AsyncResource.bind(afterSnapshot);
  const run = contextWorker.readSessionTranscriptModelContextInWorker;
  const read = vi
    .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
    .mockImplementationOnce(async (...args) => {
      const snapshot = await run(...args);
      await mutate();
      return snapshot;
    });
  return () => read.mockRestore();
}

describe("worker detached model-context branch parity", () => {
  beforeEach(async () => {
    if (hasUnjoinedOwner) {
      throw new Error("prior worker fixture remains unjoined; retained state must not be replaced");
    }
    await setupWorkerTurnLauncherTest();
  });
  afterEach(async () => {
    if (!hasUnjoinedOwner) {
      await cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
    }
  });
  afterAll(async () => {
    if (!hasUnjoinedOwner) {
      await closeStateDatabaseForTest();
    }
  });

  it.each([
    [false, undefined],
    [true, undefined],
    [false, "openclaw.runtime-context"],
    [true, "openclaw.system-update"],
  ] as const)(
    "commits a fallback after the failed candidate's own output (tool activity: %s; context: %s)",
    async (withToolActivity, customType) => {
      const runId = "worker-model-fallback";
      const inputRecorder = recorder();
      const committer = createWorkerTranscriptCommitter({
        getConfig: () => ({ session: { store: sessionTarget.storePath } }),
        store: createWorkerTranscriptCommitStore({ database }),
      });
      const identity = { ...createTranscriptCommitIdentity(SESSION_ID, 3), runId };
      const commit = async (baseLeafId: string | null, seq: number, messages: AgentMessage[]) => {
        const workerMessages = messages.map((message) => {
          const projected = toWorkerTranscriptMessage(message, "transcript");
          if (projected?.kind !== "complete") {
            throw new Error("expected a complete worker transcript message");
          }
          return projected.message;
        });
        const result = await committer.commit({
          identity,
          sessionTarget,
          assertCurrent: () => undefined,
          request: { runEpoch: 3, baseLeafId, seq, messages: workerMessages },
        });
        if (!result.ok) {
          throw new Error(`Worker transcript commit rejected: ${result.reason}`);
        }
        return result.result.newLeafId;
      };
      let failedLeaf: string | null = null;
      let candidate = 0;
      let workerLaunches = 0;
      const commitComplete = new Error("synthetic worker commit complete");
      const result = await runWithModelFallback({
        cfg: undefined,
        provider: "fixture-provider",
        model: "primary",
        manifestPlugins: [],
        fallbacksOverride: ["fixture-next/fallback"],
        run: async () => {
          candidate++;
          const launched = await launchProbe(
            runId,
            { userTurnTranscriptRecorder: inputRecorder },
            undefined,
            undefined,
            async ({ plan, turnClaim }) => {
              workerLaunches++;
              const { baseLeafId, nextSeq } = plan.assignment.transcript;
              if (candidate === 1) {
                const messages: AgentMessage[] = [];
                if (customType) {
                  messages.push(runtimeContext(customType));
                }
                if (withToolActivity) {
                  messages.push(...toolActivity("effect", "effect completed"));
                }
                messages.push(
                  makeAgentAssistantMessage({
                    content: [],
                    stopReason: "error",
                    errorMessage: "rate limit",
                  }),
                );
                await commit(baseLeafId, nextSeq, messages);
              } else {
                await commit(baseLeafId, nextSeq, [assistant("fallback answer")]);
              }
              await createWorkerSessionPlacementGate(placements).updateAckCursors({
                claim: turnClaim,
                transcriptSeq: nextSeq,
              });
              if (candidate === 1) {
                throw new FailoverError("rate limit", { reason: "rate_limit" });
              }
              // Stop this probe without asking the launcher to retry an offline transport.
              throw commitComplete;
            },
          );
          if (candidate === 1) {
            if (launched.outcome.kind !== "rejected") {
              throw new Error("expected primary failure");
            }
            failedLeaf = (await SessionManager.openAsync(sessionTarget)).getLeafId();
            throw launched.outcome.error;
          }
          if (launched.outcome.kind === "rejected" && launched.outcome.error !== commitComplete) {
            throw launched.outcome.error;
          }
          expect(launched.outcome).toEqual({ kind: "rejected", error: commitComplete });
          expect(launched.launch?.baseLeafId).toBe(failedLeaf);
          if (withToolActivity) {
            expect(launched.launch?.history).toContainEqual({
              role: "toolResult",
              text: "effect completed",
            });
          }
          return "fallback completed";
        },
      });
      expect(result.result).toBe("fallback completed");
      expect(candidate).toBe(2);
      expect(workerLaunches).toBe(2);
      expect((await SessionManager.openAsync(sessionTarget)).getLeafEntry()).toMatchObject({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "fallback answer" }] },
      });
    },
  );

  it.each([
    "context-only",
    "foreign-output",
    "foreign-context",
    "user",
    "other-custom",
    "other-entry",
  ])("keeps the admission fence for a %s suffix", async (suffix) => {
    const runId = "worker-context-fence";
    const inputRecorder = recorder();
    await inputRecorder.persistApproved();
    const admittedLeaf = inputRecorder.getAdmissionReceipt()?.entryId;
    expect(admittedLeaf).toEqual(expect.any(String));
    const writer = await SessionManager.openAsync(sessionTarget);
    const context = runtimeContext();
    await writer.appendMessageAsync(context);
    if (suffix !== "context-only") {
      await writer.appendMessageAsync(attachSessionTranscriptRunId(assistant("own output"), runId));
    }
    if (suffix === "foreign-output") {
      await writer.appendMessageAsync(attachSessionTranscriptRunId(assistant("foreign"), "other"));
    } else if (suffix === "foreign-context") {
      const foreignContext = { ...context, __openclaw: { runId: "other" } };
      await writer.appendMessageAsync(foreignContext);
    } else if (suffix === "user") {
      await writer.appendMessageAsync(user("later input"));
    } else if (suffix === "other-custom") {
      await writer.appendMessageAsync({ ...context, customType: "unrelated" });
    } else if (suffix === "other-entry") {
      await writer.appendCustomEntryAsync("unrelated", {});
    }
    const result = await launchProbe(runId, { userTurnTranscriptRecorder: inputRecorder });
    expect(result.launch).toEqual({ baseLeafId: admittedLeaf, history: [] });
  });

  it("launches a continuation from the committed interruption writes instead of the original admission", async () => {
    const original = recorder();
    await original.persistApproved();
    const originalLeaf = original.getAdmissionReceipt()?.entryId;
    expect(originalLeaf).toEqual(expect.any(String));
    const manager = await SessionManager.openAsync(sessionTarget);
    const unknown = "The node disconnected; outcome unknown. Verify state before retrying.";
    for (const message of toolActivity("interrupted", unknown, true)) {
      await manager.appendMessageAsync(message);
    }
    const committedLeaf = await manager.appendMessageAsync(assistant("Preserved partial reply", 3));
    expect(committedLeaf).not.toBe(originalLeaf);
    const stale = await launchProbe("original-recorder-borrowed", {
      suppressNextUserMessagePersistence: true,
      userTurnTranscriptRecorder: original,
    });
    expect(stale.launch?.baseLeafId).toBe(originalLeaf);
    const continuation = await launchProbe("interruption-continuation", {
      suppressNextUserMessagePersistence: true,
    });
    expect(continuation.launch?.baseLeafId).toBe(committedLeaf);
    expect(continuation.launch?.history).toContainEqual({ role: "toolResult", text: unknown });
  });

  it.each([false, true])(
    "waits for context readiness and preserves the pre-persisted input prefix (side append=%s)",
    async (sideAppend) => {
      const { manager, previousLeafId } = seedPrevious();
      const currentId = manager.appendMessage(user("current request", 3));
      let sideId: string | undefined;
      if (sideAppend) {
        manager.branch(previousLeafId);
        sideId = manager.appendMessage(user("inactive side input", 4));
        manager.appendLeafControl({
          targetId: currentId,
          appendParentId: sideId,
          appendMode: "side",
        });
        expect(manager.getLeafId()).toBe(currentId);
        expect(manager.getAppendParentId()).toBe(sideId);
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { result } = await withAsyncReadHook(
          // Readiness may arrive after the former fixture deadline on a loaded host.
          async () => {
            await vi.advanceTimersByTimeAsync(5_001);
          },
          () => launchProbe("persisted-current", { suppressNextUserMessagePersistence: true }),
          "before",
        );
        expect(result.launch).toEqual({ baseLeafId: currentId, history: priorAtModelBoundary });
        if (sideAppend) {
          const after = SessionManager.open(sessionTarget);
          expect([after.getLeafId(), after.getAppendParentId()]).toEqual([currentId, sideId]);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["in-flight", "first transcript"] as const)(
    "joins recorder admission before reading its prefix (%s)",
    async (state) => {
      if (state === "in-flight") {
        seedPrevious();
      } else {
        expect(readRows()).toEqual([]);
      }
      const inputRecorder = recorder();
      expect(inputRecorder.hasPersisted()).toBe(false);
      const pending = state === "in-flight" ? inputRecorder.persistApproved() : undefined;
      const { result, calls } = await withAsyncReadHook(
        async () => {},
        () =>
          launchProbe("recorder-admission", {
            userTurnTranscriptRecorder: inputRecorder,
          }),
      );
      await pending;
      expect(calls).toBe(1);
      expect(inputRecorder.getAdmissionReceipt()).toBeDefined();
      expect(result.launch).toEqual({
        baseLeafId: inputRecorder.getAdmissionReceipt()?.entryId,
        history: state === "in-flight" ? priorAtModelBoundary : [],
      });
      if (state === "first transcript") {
        expect(visible(SessionManager.open(sessionTarget).buildSessionContext().messages)).toEqual([
          { role: "user", text: "current request" },
        ]);
      }
    },
  );

  it.each([
    { excludeFromContext: false, appendAt: "before-read" },
    { excludeFromContext: true, appendAt: "after-snapshot" },
  ] as const)(
    "uses the recorder's admitted prefix with $appendAt activity (excluded input: $excludeFromContext)",
    async ({ excludeFromContext, appendAt }) => {
      const { manager } = seedPrevious();
      manager.appendMessage(user("earlier unanswered input"));
      const inputRecorder = recorder(excludeFromContext);
      await inputRecorder.persistApproved();
      const receipt = inputRecorder.getAdmissionReceipt();
      if (!receipt) {
        throw new Error("expected the canonical user admission");
      }
      const writer = SessionManager.open(sessionTarget);
      const originalRows = readRows();
      let appendedRows: ReturnType<typeof readRows> | undefined;
      const appendLaterActivity = async () => {
        writer.appendMessage(assistant("later activity"));
        appendedRows = readRows();
      };
      const snapshot =
        appendAt === "after-snapshot"
          ? afterNextModelContextSnapshot(appendLaterActivity)
          : undefined;
      if (appendAt === "before-read") {
        await appendLaterActivity();
      }
      try {
        const result = await launchProbe(`admitted-prefix-${excludeFromContext}-${appendAt}`, {
          userTurnTranscriptRecorder: inputRecorder,
        });

        expect(result.launch).toEqual({
          baseLeafId: receipt.entryId,
          history: [
            ...priorAtModelBoundary,
            { role: "user", text: "[Thu 1970-01-01 00:00 UTC] earlier unanswered input" },
          ],
        });
        expect(appendedRows).toBeDefined();
        expect(appendedRows?.slice(0, originalRows.length)).toEqual(originalRows);
        expect(readRows()).toEqual(appendedRows);
      } finally {
        snapshot?.();
      }
    },
  );

  it.each(["current", "cancel"] as const)(
    "joins committed runtime persistence with %s authority without replaying its input",
    async (change) => {
      const { manager } = seedPrevious();
      const beforeRows = readRows();
      const inputRecorder = recorder();
      const abort = new AbortController();
      const message = buildPersistedUserTurnMessage({
        text: "current request",
        idempotencyKey: "synthetic-current-user",
      });
      const persisted = manager.appendMessageWithTranscriptAnchor(message);
      if (!persisted.anchor) {
        throw new Error("expected canonical runtime anchor");
      }
      inputRecorder.markRuntimePersisted(message, persisted.anchor, {
        appended: persisted.appended,
      });
      const finishPersistence = createDeferredCore();
      const waiting = createDeferredCore();
      inputRecorder.markRuntimePersistencePending(finishPersistence.promise);
      const wait = inputRecorder.waitForRuntimePersistence;
      const join = vi
        .spyOn(inputRecorder, "waitForRuntimePersistence")
        .mockImplementation(async () => {
          waiting.resolve();
          await wait();
        });
      const pending = launchProbe(`runtime-recorder-${change}`, {
        userTurnTranscriptRecorder: inputRecorder,
        abortSignal: abort.signal,
      });
      try {
        await awaitGateBeforeSettlement(
          waiting.promise,
          pending,
          "turn completed before joining runtime persistence",
        );
        if (change === "cancel") {
          abort.abort(new Error("cancel while runtime persistence settles"));
        }
        finishPersistence.resolve();
        const result = await pending;
        if (change === "current") {
          expect(result.launch).toEqual({
            baseLeafId: inputRecorder.getAdmissionReceipt()?.entryId,
            history: priorAtModelBoundary,
          });
        } else {
          expect(result).toMatchObject({
            credentialCalls: 0,
            tunnelCalls: 0,
            outcome: { kind: "rejected", error: expect.any(Error) },
          });
        }
        expect(visible(SessionManager.open(sessionTarget).buildSessionContext().messages)).toEqual([
          ...prior,
          { role: "user", text: "current request" },
        ]);
        expect(readRows().slice(0, beforeRows.length)).toEqual(beforeRows);
      } finally {
        finishPersistence.resolve();
        await pending;
        await inputRecorder.waitForRuntimePersistence();
        join.mockRestore();
      }
    },
  );

  it("rejects a missing canonical user admission", async () => {
    seedPrevious();
    const inputRecorder = recorder();
    inputRecorder.markRuntimePersisted(buildPersistedUserTurnMessage({ text: "current request" }));
    const beforeRows = readRows();
    const result = await launchProbe("recorder-admission-missing", {
      userTurnTranscriptRecorder: inputRecorder,
    });
    expectNoLaunch(result);
    expect(result.outcome).toMatchObject({
      kind: "rejected",
      error: { message: "Cloud worker turn has no readable canonical user admission" },
    });
    expect(readRows()).toEqual(beforeRows);
  });

  it("retains the initial-setup writer fence across the asynchronous context read", async ({
    signal,
  }) => {
    seedPrevious();
    const paused = createDeferredCore();
    const finishSetup = createDeferredCore();
    const dispatch = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async (_request, report) =>
          await dispatchInitialWorkerPlacement({
            database,
            placements,
            identity: { ...sessionTarget, executionMode: "worker-turn" },
            workspace: root,
            onTransition: async (placement) => {
              report?.(placement);
              if (placement.state === "syncing") {
                paused.resolve();
                await finishSetup.promise;
              }
            },
          }),
      }),
      (_request, run) => run(),
    );
    const setup = dispatch.dispatch({
      ...sessionTarget,
      executionMode: "worker-turn",
      profileId: "development",
    });
    void setup.catch(() => undefined);
    const callerCurrent = vi.fn();
    const setupWaitStarted = createDeferredCore();
    const waitForInitialPlacement = vi.fn(
      (...args: Parameters<typeof dispatch.waitForInitialPlacement>) => {
        setupWaitStarted.resolve();
        return dispatch.waitForInitialPlacement(...args);
      },
    );
    try {
      await paused.promise;
      const observed = await withAsyncReadHook(
        async () => {
          await setup;
          const placement = placements.get(SESSION_ID);
          const claim = placement && projectWorkerSessionTurnClaim(placement);
          if (placement?.state !== "active" || !claim) {
            throw new Error("initial setup did not admit the worker turn");
          }
          expect(placements.validateTurnClaim(claim)).toBe(true);
          await patchSessionEntryCore(sessionTarget, () => ({
            activeWriterRunId: "replacement-writer",
          }));
          expect(placements.get(SESSION_ID)).toEqual(placement);
          expect(placements.validateTurnClaim(claim)).toBe(true);
        },
        async () => {
          const pending = launchProbe(
            "writer-after-initial-setup",
            {
              abortSignal: signal,
              suppressNextUserMessagePersistence: true,
            },
            callerCurrent,
            waitForInitialPlacement,
          );
          await withinTest(
            awaitGateBeforeSettlement(
              setupWaitStarted.promise,
              pending,
              "turn skipped the initial-setup admission wait",
            ),
            signal,
          );
          finishSetup.resolve();
          return pending;
        },
      );
      expect(waitForInitialPlacement).toHaveBeenCalledOnce();
      expect(callerCurrent).toHaveBeenCalled();
      expect(observed.calls).toBe(1);
      expectNoLaunch(observed.result);
      expect(observed.result.outcome).toMatchObject({
        kind: "rejected",
        error: { name: "AbortError", message: "Session changed while waiting for worker setup" },
      });
    } finally {
      finishSetup.resolve();
      await setup;
    }
  });

  it.each(["cancel", "claim", "caller", "session", "blocked"] as const)(
    "refuses new effects after %s changes during the context read",
    async (change) => {
      seedPrevious();
      const inputRecorder = recorder();
      const abort = new AbortController();
      let callerCurrent = true;
      const observed = await withAsyncReadHook(
        async () => {
          if (change === "cancel") {
            abort.abort(new Error("synthetic context-read cancellation"));
          } else if (change === "claim") {
            const placement = placements.get(SESSION_ID);
            const claim = placement && projectWorkerSessionTurnClaim(placement);
            if (!claim) {
              throw new Error("fixture turn claim was not admitted");
            }
            await releaseClaimIfOwned(placements, claim);
          } else if (change === "caller") {
            callerCurrent = false;
          } else if (change === "blocked") {
            inputRecorder.markBlocked();
          } else {
            await upsertSessionEntryCore(sessionTarget, {
              sessionId: "replacement-session",
              updatedAt: Date.now(),
            });
          }
        },
        () =>
          launchProbe(
            "after-read-" + change,
            {
              userTurnTranscriptRecorder: inputRecorder,
              abortSignal: abort.signal,
            },
            () => {
              if (!callerCurrent) {
                throw new Error("synthetic caller owner closed");
              }
            },
          ),
      );
      expect(observed.calls).toBe(1);
      expectNoLaunch(observed.result);
      expect(observed.result.outcome.kind).toBe("rejected");
    },
  );
});
