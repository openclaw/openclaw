import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
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
  measureLaunchTurn,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
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

async function launchProbe(input: SessionPlacementTurnParams, assertRunCurrent?: () => void) {
  seedActivePlacement();
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
  const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
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
    const workerRead = vi
      .spyOn(WorkerTaskPool.prototype, "run")
      .mockImplementationOnce(async function (this: WorkerTaskPool<unknown, unknown>, ...args) {
        workerRead.mockRestore();
        const snapshot = await this.run(...args);
        await persistInput();
        return snapshot;
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
      workerRead.mockRestore();
      synchronousRead.mockRestore();
      await pendingPersistence;
    }
  });

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

  it.each(["cancel", "claim", "caller", "session"] as const)(
    "refuses new effects after %s changes during the asynchronous context read",
    async (change) => {
      const { manager } = seedPrevious();
      manager.appendMessage(makeAgentUserMessage({ content: "current request", timestamp: 3 }));
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
              suppressNextUserMessagePersistence: true,
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
