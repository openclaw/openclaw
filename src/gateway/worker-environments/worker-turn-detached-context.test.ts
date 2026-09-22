import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    seedActivePlacement();
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
  expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
  if (launch) {
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBe(deliberateStop);
    }
  }
  return { launch, credentialCalls, tunnelCalls, outcome, deliberateStop };
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
    await afterSnapshot();
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

  it("waits for context readiness and keeps the pre-persisted current user out of replay", async () => {
    const { manager } = seedPrevious();
    const currentId = manager.appendMessage(
      makeAgentUserMessage({
        content: "current request",
        timestamp: 3,
      }),
    );
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
      expect(result.launch).toEqual({ baseLeafId: currentId, history: prior });
      expect(result.outcome).toEqual({ kind: "rejected", error: result.deliberateStop });
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins recorder persistence already in flight during preparation", async () => {
    seedPrevious();
    const inputRecorder = recorder();
    expect(inputRecorder.hasPersisted()).toBe(false);
    const pendingPersistence = inputRecorder.persistApproved();
    const result = await launchProbe({
      ...request("recorder-read-race"),
      userTurnTranscriptRecorder: inputRecorder,
    });
    await pendingPersistence;
    expect(result.launch).toEqual({
      baseLeafId: inputRecorder.getAdmissionReceipt()?.entryId,
      history: prior,
    });
  });

  it("lets the recorder create the first transcript before reading its empty prefix", async () => {
    const inputRecorder = recorder();
    expect(readWorkerTurnTranscriptStorageRows()).toEqual([]);
    const result = await launchProbe({
      ...request("initial-recorder"),
      userTurnTranscriptRecorder: inputRecorder,
    });
    expect(inputRecorder.getAdmissionReceipt()).toBeDefined();
    expect(result.launch).toEqual({
      baseLeafId: inputRecorder.getAdmissionReceipt()?.entryId,
      history: [],
    });
    expect(visible(SessionManager.open(sessionTarget).buildSessionContext().messages)).toEqual([
      { role: "user", text: "current request" },
    ]);
  });

  it("refuses a recorder persistence flag without its canonical admission", async () => {
    seedPrevious();
    const inputRecorder = recorder();
    inputRecorder.markRuntimePersisted(buildPersistedUserTurnMessage({ text: "current request" }));
    const beforeRows = readWorkerTurnTranscriptStorageRows();
    const result = await launchProbe({
      ...request("missing-recorder-admission"),
      userTurnTranscriptRecorder: inputRecorder,
    });
    expect(result.credentialCalls).toBe(0);
    expect(result.tunnelCalls).toBe(0);
    expect(result.launch).toBeUndefined();
    expect(result.outcome).toMatchObject({
      kind: "rejected",
      error: { message: "Cloud worker turn has no readable canonical user admission" },
    });
    expect(readWorkerTurnTranscriptStorageRows()).toEqual(beforeRows);
  });

  it.each([
    { excludeFromContext: false, appendAt: "before-read" },
    { excludeFromContext: true, appendAt: "before-read" },
    { excludeFromContext: false, appendAt: "after-snapshot" },
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
          history: [...prior, { role: "user", text: "earlier unanswered input" }],
        });
        expect(appendedRows).toBeDefined();
        expect(appendedRows?.slice(0, originalRows.length)).toEqual(originalRows);
        expect(readWorkerTurnTranscriptStorageRows()).toEqual(appendedRows);
      } finally {
        snapshot?.();
      }
    },
  );

  it("joins recorder persistence begun after taking the context snapshot", async () => {
    seedPrevious();
    const inputRecorder = recorder();
    let snapshotRead = false;
    let pendingPersistence: ReturnType<typeof inputRecorder.persistApproved> | undefined;
    const persistInput = () => {
      snapshotRead = true;
      pendingPersistence ??= inputRecorder.persistApproved();
      return pendingPersistence;
    };
    const workerRead = afterNextModelContextSnapshot(async () => {
      await persistInput();
    });
    const synchronousRead = vi
      .spyOn(SessionManager.prototype, "buildSessionContext")
      .mockImplementationOnce(function (this: SessionManager) {
        synchronousRead.mockRestore();
        const snapshot = this.buildSessionContext();
        void persistInput();
        return snapshot;
      });
    try {
      const result = await launchProbe({
        ...request("recorder-snapshot-overlap"),
        userTurnTranscriptRecorder: inputRecorder,
      });
      expect(snapshotRead).toBe(true);
      expect(result.outcome).toEqual({ kind: "rejected", error: result.deliberateStop });
      expect(result.launch).toEqual({
        baseLeafId: inputRecorder.getAdmissionReceipt()?.entryId,
        history: prior,
      });
      expect(visible(SessionManager.open(sessionTarget).buildSessionContext().messages)).toEqual([
        ...prior,
        { role: "user", text: "current request" },
      ]);
    } finally {
      workerRead();
      synchronousRead.mockRestore();
      await pendingPersistence;
    }
  });

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
            history: prior,
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

  it("preserves logical base leaf when durable side-append placement differs", async () => {
    const { manager, previousLeafId } = seedPrevious();
    const currentId = manager.appendMessage(
      makeAgentUserMessage({
        content: "current request",
        timestamp: 3,
      }),
    );
    manager.branch(previousLeafId);
    const sideId = manager.appendMessage(
      makeAgentUserMessage({
        content: "inactive side input",
        timestamp: 4,
      }),
    );
    manager.appendLeafControl({ targetId: currentId, appendParentId: sideId, appendMode: "side" });
    expect(manager.getLeafId()).toBe(currentId);
    expect(manager.getAppendParentId()).toBe(sideId);
    const result = await launchProbe({
      ...request("split-leaf"),
      suppressNextUserMessagePersistence: true,
    });
    expect(result.launch).toEqual({ baseLeafId: currentId, history: prior });
    const after = SessionManager.open(sessionTarget);
    expect(after.getLeafId()).toBe(currentId);
    expect(after.getAppendParentId()).toBe(sideId);
  });

  it("refuses a recorder prefix whose admitted user is removed after the worker snapshot", async () => {
    seedPrevious();
    const inputRecorder = recorder();
    await inputRecorder.persistApproved();
    const writer = SessionManager.open(sessionTarget);
    const snapshot = afterNextModelContextSnapshot(async () => {
      const admission = inputRecorder.getAdmissionReceipt();
      if (!admission) {
        throw new Error("expected an admitted user before the snapshot");
      }
      expect(writer.removeTrailingEntries((entry) => entry.id === admission.entryId)).toBe(1);
    });
    try {
      const result = await launchProbe({
        ...request("recorder-branch-rebound"),
        userTurnTranscriptRecorder: inputRecorder,
      });
      expect(inputRecorder.getAdmissionReceipt()).toBeDefined();
      expect(result.credentialCalls).toBe(0);
      expect(result.tunnelCalls).toBe(0);
      expect(result.launch).toBeUndefined();
      expect(result.outcome).toMatchObject({
        kind: "rejected",
        error: { name: "SessionTranscriptReadFenceError" },
      });
    } finally {
      snapshot();
    }
  });

  it("refuses a recorder admission removed by the model-resolution callback", async () => {
    seedPrevious();
    const inputRecorder = recorder();
    await inputRecorder.persistApproved();
    const writer = SessionManager.open(sessionTarget);
    let removed = 0;
    const result = await launchProbe({
      ...request("recorder-phase-rewrite"),
      userTurnTranscriptRecorder: inputRecorder,
      onExecutionPhase: ({ phase }) => {
        if (phase === "model_resolution") {
          const admission = inputRecorder.getAdmissionReceipt();
          removed = writer.removeTrailingEntries((entry) => entry.id === admission?.entryId);
        }
      },
    });
    expect(removed).toBe(1);
    expect(result.credentialCalls).toBe(0);
    expect(result.tunnelCalls).toBe(0);
    expect(result.launch).toBeUndefined();
    expect(result.outcome).toMatchObject({
      kind: "rejected",
      error: { name: "SessionTranscriptReadFenceError" },
    });
  });

  it("retains the initial-setup writer fence across the asynchronous context read", async () => {
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
    const waitForInitialPlacement = vi.fn(dispatch.waitForInitialPlacement);
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
        () => {
          const pending = launchProbe(
            {
              ...request("writer-after-initial-setup"),
              suppressNextUserMessagePersistence: true,
            },
            callerCurrent,
            waitForInitialPlacement,
          );
          finishSetup.resolve();
          return pending;
        },
      );
      expect(waitForInitialPlacement).toHaveBeenCalledOnce();
      expect(callerCurrent).toHaveBeenCalled();
      expect(observed.calls).toBe(1);
      expect(observed.result.credentialCalls).toBe(0);
      expect(observed.result.tunnelCalls).toBe(0);
      expect(observed.result.launch).toBeUndefined();
      expect(observed.result.outcome).toMatchObject({
        kind: "rejected",
        error: { name: "AbortError", message: "Session changed while waiting for worker setup" },
      });
    } finally {
      finishSetup.resolve();
      await setup;
    }
  });

  it.each([
    ...(["cancel", "claim", "caller", "session"] as const).flatMap((change) => [
      { change, mode: "suppressed" as const },
      { change, mode: "recorder" as const },
    ]),
    { change: "blocked" as const, mode: "recorder" as const },
  ])(
    "refuses new effects after $change changes during the $mode context read",
    async ({ change, mode }) => {
      const { manager } = seedPrevious();
      const inputRecorder = mode === "recorder" ? recorder() : undefined;
      if (!inputRecorder) {
        manager.appendMessage(makeAgentUserMessage({ content: "current request", timestamp: 3 }));
      }
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
              inputRecorder?.markBlocked();
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
              ...(inputRecorder
                ? { userTurnTranscriptRecorder: inputRecorder }
                : { suppressNextUserMessagePersistence: true }),
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
      expect(observed.result.credentialCalls).toBe(0);
      expect(observed.result.tunnelCalls).toBe(0);
      expect(observed.result.launch).toBeUndefined();
      expect(observed.result.outcome.kind).toBe("rejected");
    },
  );
});
