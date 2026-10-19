import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { bindIngressLifecycleToReplyOptions } from "../../channels/message/ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import type { SessionEntry } from "../../config/sessions.js";
import { SessionWorkStartError } from "../../config/sessions/session-work-start.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { releaseSessionControllerClaim } from "../../sessions/session-controller.mailbox.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  admitReply: vi.fn(),
  buildPreflightFailureText: vi.fn(),
  loadEntry: vi.fn(),
  queueDepth: vi.fn(() => 0),
  preflight: vi.fn(),
  recheckFallbackProbe: vi.fn(),
  refreshGoal: vi.fn(),
  resolveConfig: vi.fn(),
  resolveSendPolicy: vi.fn(),
  sendPolicy: "allow" as "allow" | "deny",
  shouldNotifyCompaction: false,
}));

// mock-isolation: Claim selection is independent of the preparation contracts below.
vi.mock("../../sessions/session-controller.mailbox.js", () => ({
  claimSessionControllerInput: vi.fn(async () => ({ abortController: new AbortController() })),
  bindSessionControllerInputOperation: vi.fn(),
  attachSessionControllerInputOperation: vi.fn(),
  releaseSessionControllerClaim: vi.fn(),
}));

vi.mock("./agent-runner-auto-fallback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-auto-fallback.js")>()),
  resolveRunAfterAutoFallbackPrimaryProbeRecheck: (...args: unknown[]) =>
    state.recheckFallbackProbe(...args),
}));

// mock-isolation: The fixture controls preflight rotation and failure without running compaction or session writes.
vi.mock("./reply-turn-preflight.js", () => ({
  prepareReplyTurnContext: (...args: unknown[]) => state.preflight(...args),
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: (...args: unknown[]) => state.resolveConfig(...args),
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));

// mock-isolation: Preparation cases supply an owned or rejected turn without admitting a second real controller operation.
vi.mock("./reply-turn-admission.js", () => ({
  admitReplyTurn: (...args: unknown[]) => state.admitReply(...args),
}));

// mock-isolation: Admission fixtures supply session changes directly without starting a database worker.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryInWorker: async (...args: unknown[]) => state.loadEntry(...args),
  readSessionEntryReadOnlyInWorker: async (...args: unknown[]) => state.loadEntry(...args),
}));

// mock-isolation: Pending inputs are controlled independently of this admission.
vi.mock("./queue/enqueue.js", () => ({
  getFollowupQueueDepth: () => state.queueDepth(),
  enqueueFollowupRun: vi.fn(),
}));

vi.mock("../../sessions/send-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/send-policy.js")>()),
  resolveSendPolicy: (...args: unknown[]) => state.resolveSendPolicy(...args),
}));

vi.mock("./inbound-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-meta.js")>()),
  refreshActiveGoalContext: (...args: unknown[]) => state.refreshGoal(...args),
}));

vi.mock("./compaction-notice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./compaction-notice.js")>()),
  createCompactionNoticePayload: ({ phase }: { phase: string }) => ({ text: phase }),
  shouldNotifyUserAboutCompaction: () => state.shouldNotifyCompaction,
}));

vi.mock("./agent-runner-failure-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-failure-reply.js")>()),
  buildPreflightCompactionFailureText: (...args: unknown[]) =>
    state.buildPreflightFailureText(...args),
}));

const { prepareReplyAgentTurn } = await import("./reply-agent-turn-preparation.js");

function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "queued-session",
      sessionKey: "main",
      sessionFile: "/tmp/queued.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

function createOperation(sessionId = "queued-session") {
  return {
    sessionId,
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    abortForRestart: vi.fn(() => true),
    retainFailureUntilComplete: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
}

function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    typing: {} as never,
    typingMode: "never" as const,
    defaultModel: "claude",
    sessionKey: "main",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.admitReply.mockResolvedValue({ status: "owned", operation: createOperation() });
  state.queueDepth.mockReturnValue(0);
  state.sendPolicy = "allow";
  state.shouldNotifyCompaction = false;
  state.resolveSendPolicy.mockImplementation(() => state.sendPolicy);
  state.resolveConfig.mockImplementation(async (config) => config);
  state.buildPreflightFailureText.mockReturnValue("preflight failed");
  state.preflight.mockImplementation(async ({ sessionEntry }) => sessionEntry);
  state.recheckFallbackProbe.mockImplementation(({ run }) => run);
  state.refreshGoal.mockImplementation((context) => context);
});

function createActiveGoalEntry(): SessionEntry {
  return {
    sessionId: "queued-session",
    updatedAt: 1,
    goal: {
      schemaVersion: 1,
      id: "goal",
      objective: "Finish",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    },
  };
}

describe("prepareReplyAgentTurn", () => {
  it("retains an undefined preflight rejection as an executable failure", async () => {
    state.preflight.mockRejectedValueOnce(undefined);

    const result = await prepareReplyAgentTurn({
      queued: createRun(),
      defaults: createDefaults(),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: { preflightError: expect.any(Error) },
    });
    if (result.kind !== "admitted") {
      throw new Error("Expected the admitted turn to retain its preflight failure");
    }
    expect(result.turn.preflightError).toMatchObject({
      message: "Reply preparation failed",
      cause: undefined,
    });
  });

  it("reports a queued event's admission refusal to its source before consuming it", async () => {
    const error = new SessionWorkStartError("archived", "Restore this session before retrying.");
    state.admitReply.mockResolvedValue({
      status: "skipped",
      reason: "lifecycle-invalidated",
      error,
    });
    const queued = createRun();
    const onFailed = vi.fn();
    queued.run.internalEventExecution = {
      onStarted: vi.fn(),
      onTerminal: vi.fn(),
      onFailed,
    };

    await expect(prepareReplyAgentTurn({ queued, defaults: createDefaults() })).resolves.toEqual({
      kind: "skipped",
      reason: "lifecycle-invalidated",
    });
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(error);
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it.each([
    "paused",
    "blocked",
    "complete",
    "budget_limited",
    "usage_limited",
    "replaced",
    "cleared",
    "new input",
  ] as const)("drops an automatic Goal nudge when admission observes %s", async (change) => {
    const operation = createOperation();
    const original = createActiveGoalEntry();
    const onQueuedFollowupAdmitted = vi.fn(async () => {});
    const onQueuedFollowupSettled = vi.fn(async () => {});
    const current = structuredClone(original);
    if (change === "replaced") {
      current.goal!.id = "replacement";
    } else if (change === "cleared") {
      current.goal = undefined;
    } else if (change === "new input") {
      state.queueDepth.mockReturnValue(1);
    } else {
      current.goal!.status = change;
    }
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: current });
    state.loadEntry.mockReturnValue(current);
    const result = await prepareReplyAgentTurn({
      queued: createRun({
        goalContinuation: { sessionId: "queued-session", goalId: "goal" },
      }),
      defaults: createDefaults({
        sessionEntry: original,
        storePath: "/fixture/sessions.json",
        opts: { onQueuedFollowupAdmitted, onQueuedFollowupSettled },
      }),
    });
    expect(result).toMatchObject({ kind: "skipped", reason: "goal-inactive", operation });
    expect(onQueuedFollowupAdmitted).toHaveBeenCalledOnce();
    expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
    expect(operation.complete).not.toHaveBeenCalled();
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("rechecks the Goal after awaited compaction preparation", async () => {
    const operation = createOperation();
    const original = createActiveGoalEntry();
    const onQueuedFollowupAdmitted = vi.fn(async () => {});
    const onQueuedFollowupSettled = vi.fn(async () => {});
    let current = original;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: original });
    state.loadEntry.mockImplementation(() => current);
    state.preflight.mockImplementation(async () => {
      current = {
        ...original,
        updatedAt: 2,
        goal: { ...original.goal!, status: "paused", updatedAt: 2 },
      };
      return original;
    });
    const result = await prepareReplyAgentTurn({
      queued: createRun({
        goalContinuation: { sessionId: "queued-session", goalId: "goal" },
      }),
      defaults: createDefaults({
        sessionEntry: original,
        storePath: "/fixture/sessions.json",
        opts: { onQueuedFollowupAdmitted, onQueuedFollowupSettled },
      }),
    });
    expect(result).toMatchObject({ kind: "skipped", reason: "goal-inactive", operation });
    expect(onQueuedFollowupAdmitted).toHaveBeenCalledOnce();
    expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
    expect(operation.complete).not.toHaveBeenCalled();
  });

  it.each([{ sessionKey: undefined, expected: "legacy-target" }])(
    "preserves the admitted transcript target $expected",
    async ({ sessionKey, expected }) => {
      const queued = createRun();
      queued.run.sessionKey = sessionKey;
      queued.run.sessionFile = "legacy-target";
      state.admitReply.mockResolvedValue({
        status: "owned",
        operation: createOperation("admitted-session"),
      });

      const result = await prepareReplyAgentTurn({
        queued,
        defaults: createDefaults({ sessionKey }),
      });

      expect(result.kind).toBe("admitted");
      if (result.kind === "admitted") {
        expect(result.turn.queued.run.sessionFile).toBe(expected);
      }
    },
  );

  it("retires a selected source refused by reply admission without adopting it", async () => {
    state.admitReply.mockResolvedValue({ status: "skipped", reason: "active-run" });
    const onAdopted = vi.fn();
    const queued = createRun({ turnAdoptionLifecycle: { onAdopted } });

    await expect(prepareReplyAgentTurn({ queued, defaults: createDefaults() })).resolves.toEqual({
      kind: "skipped",
      reason: "lifecycle-invalidated",
    });
    expect(releaseSessionControllerClaim).toHaveBeenCalledOnce();
    expect(onAdopted).not.toHaveBeenCalled();
  });

  it("stops when reply admission aborts the queued source", async () => {
    const controller = new AbortController();
    const operation = createOperation();
    state.admitReply.mockImplementation(async () => {
      controller.abort();
      return { status: "owned", operation };
    });

    await expect(
      prepareReplyAgentTurn({
        queued: createRun({ queueAbortSignal: controller.signal }),
        defaults: createDefaults(),
      }),
    ).resolves.toMatchObject({ kind: "skipped", reason: "aborted", operation });
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("keeps ingress retryable when queued preparation fails before input acceptance", async () => {
    vi.useFakeTimers();
    try {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        const failure = new Error("ENOSPC: queued turn preparation failed");
        state.admitReply.mockResolvedValue({ status: "owned", operation: createOperation() });
        await queue.enqueue("queued-input", { text: "Please answer this message" });
        const drain = createChannelIngressDrain({
          queue,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            await prepareReplyAgentTurn({
              queued: createRun(bindIngressLifecycleToReplyOptions(lifecycle)),
              defaults: createDefaults({
                opts: {
                  onQueuedFollowupAdmitted: async () => {
                    throw failure;
                  },
                },
              }),
            });
          },
        });
        try {
          await drain.drainOnce();
          await drain.waitForIdle();
          expect(await queue.listPending()).toMatchObject([
            { id: "queued-input", attempts: 1, lastError: failure.message },
          ]);
          expect((await queue.enqueue("queued-input", { text: "duplicate" })).kind).toBe("pending");
        } finally {
          drain.dispose();
        }
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("uses admission-time session generation, model lock, policy, and goal context", async () => {
    const operation = createOperation("admitted-session");
    const queuedEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const admittedEntry: SessionEntry = {
      sessionId: "admitted-session",
      modelSelectionLocked: true,
      updatedAt: 2,
    };
    const sessionStore = { main: queuedEntry };
    const onQueuedFollowupAdmitted = vi.fn(async () => {});
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: admittedEntry });
    state.loadEntry.mockReturnValue(admittedEntry);
    state.sendPolicy = "deny";
    state.refreshGoal.mockReturnValue({ text: "fresh goal" });
    state.preflight.mockImplementation(async ({ sessionEntry }) => sessionEntry);

    const result = await prepareReplyAgentTurn({
      queued: createRun({
        currentInboundContext: { text: "stale goal" },
        originatingChatType: "group",
      }),
      defaults: createDefaults({
        sessionEntry: queuedEntry,
        sessionStore,
        storePath: "/tmp/sessions.json",
        opts: { onQueuedFollowupAdmitted },
      }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.run).toMatchObject({
        sessionId: "admitted-session",
        sessionFile: "main",
        modelSelectionLocked: true,
      });
      expect(result.turn.queued.currentInboundContext).toEqual({ text: "fresh goal" });
      expect(result.turn.sendPolicy).toBe("deny");
      expect(result.turn.session.current()).toBe(admittedEntry);
    }
    expect(onQueuedFollowupAdmitted).toHaveBeenCalledOnce();
    expect(state.resolveSendPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ chatType: "group" }),
    );
  });

  it("settles presentation and releases the reply operation when dispatcher setup fails", async () => {
    const operation = createOperation();
    const failure = new Error("dispatcher reset failed");
    const onQueuedFollowupSettled = vi.fn(async () => {});
    state.admitReply.mockResolvedValue({ status: "owned", operation });

    await expect(
      prepareReplyAgentTurn({
        queued: createRun(),
        defaults: createDefaults({
          opts: {
            onQueuedFollowupAdmitted: vi.fn(async () => {
              throw failure;
            }),
            onQueuedFollowupSettled,
          },
        }),
      }),
    ).rejects.toBe(failure);
    expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("keeps the model selected at admission when preferences change during source adoption", async () => {
    const queued = createRun();
    state.admitReply.mockImplementation(async ({ captureRunSelection }) => {
      queued.run.model = "selected-at-admission";
      captureRunSelection();
      return { status: "owned", operation: createOperation() };
    });

    const result = await prepareReplyAgentTurn({
      queued,
      defaults: createDefaults({
        opts: {
          onQueuedFollowupAdmitted: async () => {
            queued.run.model = "next-turn-model";
          },
        },
      }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.run.model).toBe("selected-at-admission");
    }
    expect(queued.run.model).toBe("next-turn-model");
  });

  it("clears queued generation facts when only the lifecycle revision advances", async () => {
    const operation = createOperation();
    const queuedEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "queued-revision",
      updatedAt: 1,
    };
    const admittedEntry: SessionEntry = {
      ...queuedEntry,
      lifecycleRevision: "admitted-revision",
      updatedAt: 2,
    };
    const sessionStore = { main: queuedEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: admittedEntry });
    state.loadEntry.mockReturnValue(admittedEntry);
    const queued = createRun();
    queued.run.cliSessionBindingFacts = { provider: "claude-cli" } as never;
    queued.run.autoFallbackPrimaryProbe = { provider: "anthropic", model: "claude" } as never;

    const result = await prepareReplyAgentTurn({
      queued,
      defaults: createDefaults({ sessionEntry: queuedEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.run.cliSessionBindingFacts).toBeUndefined();
      expect(result.turn.queued.run.autoFallbackPrimaryProbe).toBeUndefined();
    }
  });

  it("does not pass stale enqueue-time state into a rotated session generation", async () => {
    const operation = createOperation("rotated-session");
    const staleEntry: SessionEntry = {
      sessionId: "queued-session",
      modelSelectionLocked: true,
      updatedAt: 1,
    };
    const sessionStore = { main: staleEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.loadEntry.mockReturnValue(undefined);

    const result = await prepareReplyAgentTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: staleEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.run.modelSelectionLocked).toBe(false);
    }
    expect(state.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ sessionEntry: undefined }),
    );
    const preflightParams = state.preflight.mock.calls[0]?.[0] as {
      sessionStore?: Record<string, SessionEntry>;
    };
    expect(preflightParams.sessionStore?.main).toBeUndefined();
    expect(state.refreshGoal).toHaveBeenCalledWith(undefined, undefined);
  });

  it("refreshes send policy and goal context after preflight rotates the generation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const rotatedEntry: SessionEntry = { sessionId: "compacted-session", updatedAt: 2 };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    state.refreshGoal.mockImplementation((_context, entry) => ({ text: entry?.sessionId }));
    state.preflight.mockImplementation(async () => {
      state.sendPolicy = "deny";
      return rotatedEntry;
    });

    const result = await prepareReplyAgentTurn({
      queued: createRun({ currentInboundContext: { text: "stale" } }),
      defaults: createDefaults({ sessionStore, sessionEntry: initialEntry }),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: {
        sendPolicy: "deny",
        queued: { currentInboundContext: { text: "compacted-session" } },
      },
    });
  });

  it("rechecks send policy before an in-preflight compaction notice", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const deniedEntry: SessionEntry = { ...initialEntry, updatedAt: 2 };
    const onCompactionNotice = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(deniedEntry);
    state.resolveSendPolicy.mockImplementation(({ entry }) =>
      entry === deniedEntry ? "deny" : "allow",
    );
    state.preflight.mockImplementation(async ({ onCompactionNotice: emitCompactionNotice }) => {
      await emitCompactionNotice?.("end");
      return deniedEntry;
    });

    await prepareReplyAgentTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      onCompactionNotice,
    });

    expect(onCompactionNotice).not.toHaveBeenCalled();
    expect(state.resolveSendPolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({ entry: deniedEntry }),
    );
  });

  it("delivers a terminal compaction notice after adopting its rotated generation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      lifecycleRevision: "compacted",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    const onCompactionNotice = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice: emitCompactionNotice }) => {
      sessionStore.main = rotatedEntry;
      await emitCompactionNotice?.("end");
      return rotatedEntry;
    });

    const result = await prepareReplyAgentTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      onCompactionNotice,
    });

    expect(result).toMatchObject({ kind: "admitted" });
    expect(onCompactionNotice).toHaveBeenCalledWith(
      "end",
      undefined,
      expect.objectContaining({
        sendPolicy: "allow",
        queued: expect.objectContaining({
          run: expect.objectContaining({ sessionId: "compacted-session" }),
        }),
      }),
    );
  });

  it("releases the admitted operation when deferred terminal notice delivery fails", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const failure = new Error("notice delivery failed");
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice: emitCompactionNotice }) => {
      await emitCompactionNotice?.("end");
      return initialEntry;
    });

    await expect(
      prepareReplyAgentTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry }),
        onCompactionNotice: vi.fn(async () => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("delivers an incomplete terminal notice after ordinary preflight failure", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const onCompactionNotice = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice: emitCompactionNotice }) => {
      await emitCompactionNotice?.("start");
      await emitCompactionNotice?.("incomplete");
      throw new Error("preflight failed");
    });

    const result = await prepareReplyAgentTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry }),
      onCompactionNotice,
    });

    expect(result).toMatchObject({ kind: "admitted", turn: { preflightFailurePayload: {} } });
    expect(onCompactionNotice).toHaveBeenCalledTimes(2);
    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start", undefined, expect.anything());
    expect(onCompactionNotice).toHaveBeenNthCalledWith(
      2,
      "incomplete",
      undefined,
      expect.anything(),
    );
  });

  it("keeps an owned preflight rotation when preflight later fails", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      lifecycleRevision: "compacted",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(
      async ({ sessionStore: ownedStore }: { sessionStore: Record<string, SessionEntry> }) => {
        ownedStore.main = rotatedEntry;
        throw new Error("preflight failed after rotation");
      },
    );

    const result = await prepareReplyAgentTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: {
        queued: { run: { sessionId: "compacted-session" } },
        preflightFailurePayload: {},
      },
    });
    expect(operation.updateSessionId).toHaveBeenCalledWith("compacted-session");
  });

  it("keeps preflight failure cancellation live while refreshing send policy", async () => {
    const upstreamAbort = new AbortController();
    const operation = createReplyOperation({
      sessionKey: "agent:main:queued-preflight-cancel",
      sessionId: "queued-session",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async () => {
      state.sendPolicy = "deny";
      throw new Error("preflight failed");
    });

    try {
      const result = await prepareReplyAgentTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      });
      expect(result).toMatchObject({
        kind: "admitted",
        turn: { sendPolicy: "deny", preflightFailurePayload: { text: "preflight failed" } },
      });
      upstreamAbort.abort(new Error("source canceled before input acceptance"));
      expect(operation.abortSignal.aborted).toBe(true);
    } finally {
      operation.complete();
    }
  });

  it("retains the preflight owner's public recovery guidance for a queued turn", async () => {
    const userMessage = "The saved history exceeds its limit. Use /new, then resend your message.";
    state.preflight.mockRejectedValue(
      new AgentHarnessPreflightError(
        "Preflight compaction required but failed: private diagnostic",
        {
          userMessage,
        },
      ),
    );
    const result = await prepareReplyAgentTurn({ queued: createRun(), defaults: createDefaults() });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: { preflightFailurePayload: { text: userMessage } },
    });
    expect(state.buildPreflightFailureText).not.toHaveBeenCalled();
  });
});
