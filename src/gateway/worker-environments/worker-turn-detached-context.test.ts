import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
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
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { createCoordinatorTestService } from "./placement-dispatch-coordinator.test-support.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { WorkerRunnerUnavailableError, type WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { releaseClaimIfOwned } from "./worker-turn-admission.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  database,
  dispatchInitialWorkerPlacement,
  measureLaunchTurn,
  readLaunchToolNames,
  placements,
  readWorkerTurnTranscriptStorageRows,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
  type WorkerTurnLauncherOptions,
} from "./worker-turn-launcher.test-support.js";

function visible(messages: readonly unknown[]) {
  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      throw new Error("invalid synthetic history");
    }
    const item = message as { role?: string; content?: unknown };
    const text =
      typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content
              .map((part: unknown) =>
                part && typeof part === "object" && "text" in part && typeof part.text === "string"
                  ? part.text
                  : "",
              )
              .join("")
          : "";
    return { role: item.role, text };
  });
}

function seedPrevious() {
  const manager = SessionManager.open(sessionTarget);
  manager.appendMessage(makeAgentUserMessage({ content: "previous request", timestamp: 1 }));
  const previousLeafId = manager.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "text", text: "previous answer" }],
      timestamp: 2,
    }),
  );
  return { manager, previousLeafId };
}

const prior = [
  { role: "user", text: "previous request" },
  { role: "assistant", text: "previous answer" },
];
const priorAtModelBoundary = [
  { role: "user", text: "[Thu 1970-01-01 00:00 UTC] previous request" },
  { role: "assistant", text: "previous answer" },
];

function recorder() {
  return createUserTurnTranscriptRecorder({
    target: { ...sessionTarget, sessionEntry: undefined },
    input: {
      text: "current request",
      idempotencyKey: "synthetic-current-user",
    },
  });
}

let hasUnjoinedOwner = false;

function request(runId: string): SessionPlacementTurnParams {
  return { ...turn(runId), prompt: "current request", transcriptPrompt: "current request" };
}

async function launchProbe(
  input: SessionPlacementTurnParams,
  assertRunCurrent?: () => void,
  waitForInitialPlacement?: WorkerTurnLauncherOptions["waitForInitialPlacement"],
) {
  if (!waitForInitialPlacement) {
    await seedActivePlacement();
  }
  const deliberateStop = new WorkerRunnerUnavailableError();
  let credentialCalls = 0;
  let tunnelCalls = 0;
  let launch: { baseLeafId: string | null; history: ReturnType<typeof visible> } | undefined;
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected virtual transport operation");
  };
  const tunnel: WorkerTurnTunnelHandle = {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    runWorkspaceCommand: unexpected,
    syncWorkspace: unexpected,
    quiesceWorkspace: unexpected,
    reconcileWorkspace: unexpected,
    stop: async () => {},
    measureLaunchTurn,
    readLaunchToolNames,
    launchTurn: async ({ plan }) => {
      launch = {
        baseLeafId: plan.assignment.transcript.baseLeafId,
        history: visible(plan.assignment.initialMessages),
      };
      // Never call onDispatchReady: no remote turn or credential delivery occurs.
      throw deliberateStop;
    },
  };
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
  if (launch) {
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBe(deliberateStop);
    }
  }
  return { launch, credentialCalls, tunnelCalls, outcome, deliberateStop };
}

function expectNoLaunch(result: Awaited<ReturnType<typeof launchProbe>>) {
  expect(result.credentialCalls).toBe(0);
  expect(result.tunnelCalls).toBe(0);
  expect(result.launch).toBeUndefined();
}

async function withAsyncReadHook<T>(
  hooks: { before?: () => Promise<void>; after?: () => Promise<void> },
  run: () => Promise<T>,
) {
  const original = SessionManager.openModelContextAsync.bind(SessionManager);
  const descriptor = Object.getOwnPropertyDescriptor(SessionManager, "openModelContextAsync")!;
  let calls = 0;
  Object.defineProperty(SessionManager, "openModelContextAsync", {
    ...descriptor,
    value: async (...args: Parameters<typeof original>) => {
      calls++;
      await hooks.before?.();
      const result = await original(...args);
      await hooks.after?.();
      return result;
    },
  });
  try {
    return { result: await run(), calls };
  } finally {
    Object.defineProperty(SessionManager, "openModelContextAsync", descriptor);
  }
}

function afterNextModelContextSnapshot(afterSnapshot: () => Promise<void>) {
  // The concurrent writer must not borrow the reader's transcript admission fence.
  const mutate = AsyncResource.bind(afterSnapshot);
  let read = vi.spyOn(WorkerTaskPool.prototype, "run");
  async function intercept(
    this: WorkerTaskPool<unknown, unknown>,
    ...args: Parameters<WorkerTaskPool<unknown, unknown>["run"]>
  ) {
    read.mockRestore();
    const run = this.run.bind(this);
    const input = args[0];
    if (
      !input ||
      typeof input !== "object" ||
      !("kind" in input) ||
      input.kind !== "model-context"
    ) {
      read = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(intercept);
      return await run(...args);
    }
    const snapshot = await run(...args);
    await mutate();
    return snapshot;
  }
  read.mockImplementation(intercept);
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
      await cleanupWorkerTurnLauncherTest();
    }
  });

  it.each([false, true])(
    "waits for context readiness and preserves the pre-persisted input prefix (side append=%s)",
    async (sideAppend) => {
      const { manager, previousLeafId } = seedPrevious();
      const currentId = manager.appendMessage(
        makeAgentUserMessage({
          content: "current request",
          timestamp: 3,
        }),
      );
      let sideId: string | undefined;
      if (sideAppend) {
        manager.branch(previousLeafId);
        sideId = manager.appendMessage(
          makeAgentUserMessage({ content: "inactive side input", timestamp: 4 }),
        );
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
          {
            // Readiness may arrive after the former fixture deadline on a loaded host.
            before: async () => {
              await vi.advanceTimersByTimeAsync(5_001);
            },
          },
          () =>
            launchProbe({
              ...request("persisted-current"),
              suppressNextUserMessagePersistence: true,
            }),
        );
        expect(result.launch).toEqual({ baseLeafId: currentId, history: priorAtModelBoundary });
        expect(result.outcome).toEqual({ kind: "rejected", error: result.deliberateStop });
        if (sideAppend) {
          const after = SessionManager.open(sessionTarget);
          expect(after.getLeafId()).toBe(currentId);
          expect(after.getAppendParentId()).toBe(sideId);
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
        expect(readWorkerTurnTranscriptStorageRows()).toEqual([]);
      }
      const inputRecorder = recorder();
      expect(inputRecorder.hasPersisted()).toBe(false);
      const pending = state === "in-flight" ? inputRecorder.persistApproved() : undefined;
      const result = await launchProbe({
        ...request("recorder-admission"),
        userTurnTranscriptRecorder: inputRecorder,
      });
      await pending;
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
      manager.appendMessage(makeAgentUserMessage({ content: "earlier unanswered input" }));
      const inputRecorder = createUserTurnTranscriptRecorder({
        target: { ...sessionTarget, sessionEntry: undefined },
        input: {
          text: "current request",
          idempotencyKey: "synthetic-current-user",
          ...(excludeFromContext ? { excludeFromContext: true } : {}),
        },
      });
      await inputRecorder.persistApproved();
      const receipt = inputRecorder.getAdmissionReceipt();
      if (!receipt) {
        throw new Error("expected the canonical user admission");
      }
      const writer = SessionManager.open(sessionTarget);
      const originalRows = readWorkerTurnTranscriptStorageRows();
      let appendedRows: ReturnType<typeof readWorkerTurnTranscriptStorageRows> | undefined;
      const appendLaterActivity = async () => {
        writer.appendMessage(
          makeAgentAssistantMessage({ content: [{ type: "text", text: "later activity" }] }),
        );
        appendedRows = readWorkerTurnTranscriptStorageRows();
      };
      const snapshot =
        appendAt === "after-snapshot"
          ? afterNextModelContextSnapshot(appendLaterActivity)
          : undefined;
      if (appendAt === "before-read") {
        await appendLaterActivity();
      }
      try {
        const result = await launchProbe({
          ...request(`admitted-prefix-${excludeFromContext}-${appendAt}`),
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
        expect(readWorkerTurnTranscriptStorageRows()).toEqual(appendedRows);
      } finally {
        snapshot?.();
      }
    },
  );

  it.each(["current", "cancel"] as const)(
    "joins committed runtime persistence with %s authority without replaying its input",
    async (change) => {
      const { manager } = seedPrevious();
      const beforeRows = readWorkerTurnTranscriptStorageRows();
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
      const pending = launchProbe({
        ...request(`runtime-recorder-${change}`),
        userTurnTranscriptRecorder: inputRecorder,
        abortSignal: abort.signal,
      });
      try {
        expect(
          await Promise.race([
            waiting.promise.then(() => "joining"),
            pending.then(() => "finished"),
          ]),
        ).toBe("joining");
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
          expect(result.credentialCalls).toBe(0);
          expect(result.tunnelCalls).toBe(0);
          expect(result.outcome).toMatchObject({ kind: "rejected", error: expect.any(Error) });
        }
        expect(visible(SessionManager.open(sessionTarget).buildSessionContext().messages)).toEqual([
          ...prior,
          { role: "user", text: "current request" },
        ]);
        expect(readWorkerTurnTranscriptStorageRows().slice(0, beforeRows.length)).toEqual(
          beforeRows,
        );
      } finally {
        finishPersistence.resolve();
        await pending;
        await inputRecorder.waitForRuntimePersistence();
        join.mockRestore();
      }
    },
  );

  it.each(["missing", "after-snapshot", "model-resolution"] as const)(
    "rejects a missing or removed canonical user admission (%s)",
    async (stage) => {
      seedPrevious();
      const inputRecorder = recorder();
      if (stage === "missing") {
        inputRecorder.markRuntimePersisted(
          buildPersistedUserTurnMessage({ text: "current request" }),
        );
      } else {
        await inputRecorder.persistApproved();
      }
      const beforeRows = stage === "missing" ? readWorkerTurnTranscriptStorageRows() : undefined;
      const writer = SessionManager.open(sessionTarget);
      let removed = 0;
      const removeAdmission = () => {
        const admission = inputRecorder.getAdmissionReceipt();
        if (!admission) {
          throw new Error("expected an admitted user before removal");
        }
        removed = writer.removeTrailingEntries((entry) => entry.id === admission.entryId);
        expect(removed).toBe(1);
      };
      const restore =
        stage === "after-snapshot"
          ? afterNextModelContextSnapshot(async () => removeAdmission())
          : undefined;
      try {
        const result = await launchProbe({
          ...request(`recorder-admission-${stage}`),
          userTurnTranscriptRecorder: inputRecorder,
          ...(stage === "model-resolution"
            ? {
                onExecutionPhase: ({ phase }) => {
                  if (phase === "model_resolution") {
                    removeAdmission();
                  }
                },
              }
            : {}),
        });
        expectNoLaunch(result);
        expect(result.outcome).toMatchObject({
          kind: "rejected",
          error:
            stage === "missing"
              ? { message: "Cloud worker turn has no readable canonical user admission" }
              : { name: "SessionTranscriptReadFenceError" },
        });
        if (stage === "missing") {
          expect(readWorkerTurnTranscriptStorageRows()).toEqual(beforeRows);
        } else {
          expect(
            removed,
            result.outcome.kind === "rejected" ? String(result.outcome.error) : "resolved",
          ).toBe(1);
          expect(inputRecorder.getAdmissionReceipt()).toBeDefined();
        }
      } finally {
        restore?.();
      }
    },
  );

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
        {
          after: async () => {
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
        },
        async () => {
          const pending = launchProbe(
            {
              ...request("writer-after-initial-setup"),
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
        {
          after: async () => {
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
        },
        () =>
          launchProbe(
            {
              ...request("after-read-" + change),
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
