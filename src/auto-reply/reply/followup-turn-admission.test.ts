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
import type { FollowupRun } from "./queue.js";
import { createReplyOperation } from "./reply-run-registry.js";

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

vi.mock("./agent-runner-auto-fallback.js", () => ({
  resolveRunAfterAutoFallbackPrimaryProbeRecheck: (...args: unknown[]) =>
    state.recheckFallbackProbe(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: (...args: unknown[]) => state.preflight(...args),
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: (...args: unknown[]) => state.resolveConfig(...args),
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));

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

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: (...args: unknown[]) => state.resolveSendPolicy(...args),
}));

vi.mock("./inbound-meta.js", () => ({
  refreshActiveGoalContext: (...args: unknown[]) => state.refreshGoal(...args),
}));

vi.mock("./compaction-notice.js", () => ({
  createCompactionNoticePayload: ({ phase }: { phase: string }) => ({ text: phase }),
  shouldNotifyUserAboutCompaction: () => state.shouldNotifyCompaction,
}));

vi.mock("./agent-runner-failure-reply.js", () => ({
  buildPreflightCompactionFailureText: (...args: unknown[]) =>
    state.buildPreflightFailureText(...args),
}));

const { admitFollowupTurn } = await import("./followup-turn-admission.js");

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

describe("admitFollowupTurn", () => {
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

    await expect(admitFollowupTurn({ queued, defaults: createDefaults() })).resolves.toEqual({
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
    const result = await admitFollowupTurn({
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
    const result = await admitFollowupTurn({
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

      const result = await admitFollowupTurn({ queued, defaults: createDefaults({ sessionKey }) });

      expect(result.kind).toBe("admitted");
      if (result.kind === "admitted") {
        expect(result.turn.queued.run.sessionFile).toBe(expected);
      }
    },
  );

  it("reports each active-run deferral without adopting the queued source", async () => {
    state.admitReply.mockResolvedValue({ status: "skipped", reason: "active-run" });
    const onDeferredHeartbeat = vi.fn();
    const onAdopted = vi.fn();
    const queued = createRun({
      turnAdoptionLifecycle: { onAdopted, onDeferredHeartbeat },
    });

    await expect(admitFollowupTurn({ queued, defaults: createDefaults() })).resolves.toEqual({
      kind: "deferred",
      reason: "active-run",
    });
    await expect(admitFollowupTurn({ queued, defaults: createDefaults() })).resolves.toEqual({
      kind: "deferred",
      reason: "active-run",
    });
    expect(onDeferredHeartbeat).toHaveBeenCalledTimes(2);
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
      admitFollowupTurn({
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
            await admitFollowupTurn({
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

    const result = await admitFollowupTurn({
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
    expect(operation.retainFailureUntilComplete).toHaveBeenCalledOnce();
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
      admitFollowupTurn({
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

    const result = await admitFollowupTurn({
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

    const result = await admitFollowupTurn({
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

  it("advances the owned lifecycle generation only through explicit adoption", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "revision-a",
      updatedAt: 1,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      const replacement = {
        ...initialEntry,
        lifecycleRevision: "revision-b",
        updatedAt: 2,
      };
      result.turn.session.adopt(replacement);
      result.turn.session.publish(initialEntry);
      expect(result.turn.session.current()).toBe(replacement);
      const newerSameGeneration = {
        ...replacement,
        updatedAt: 4,
      };
      result.turn.session.adopt(newerSameGeneration);
      result.turn.session.publish(replacement);
      expect(result.turn.session.current()).toBe(newerSameGeneration);

      const concurrentEntry = {
        ...initialEntry,
        lifecycleRevision: "revision-c",
        updatedAt: 3,
      };
      sessionStore.main = concurrentEntry;
      result.turn.session.publish(replacement);
      expect(sessionStore.main).toBe(concurrentEntry);
    }
  });

  it("does not treat an absent admitted lifecycle revision as a wildcard", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      sessionStore.main = {
        ...initialEntry,
        lifecycleRevision: "replacement",
        updatedAt: 2,
      };
      expect(result.turn.session.current()).toBe(initialEntry);
    }
  });

  it("does not republish a generation deleted after admission", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "admitted",
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      delete sessionStore.main;
      result.turn.session.publish({ ...initialEntry, updatedAt: 2 });
      expect(sessionStore.main).toBeUndefined();
    }
  });

  it("adopts a generation already published by owned preflight compaction", async () => {
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
    const publishedEntry: SessionEntry = {
      ...rotatedEntry,
      verboseLevel: "full",
      updatedAt: 3,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    state.preflight.mockImplementation(async () => {
      sessionStore.main = publishedEntry;
      return rotatedEntry;
    });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionStore, sessionEntry: initialEntry }),
    });

    expect(result).toMatchObject({ kind: "admitted" });
    if (result.kind === "admitted") {
      expect(result.turn.session.current()).toBe(publishedEntry);
    }
    expect(state.resolveSendPolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({ entry: publishedEntry }),
    );
  });

  it("forwards owned preflight deletion to the backing session store", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const sessionStore: Record<string, SessionEntry> = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(
      async ({ sessionStore: ownedStore }: { sessionStore: Record<string, SessionEntry> }) => {
        delete ownedStore.main;
        return initialEntry;
      },
    );

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      }),
    ).rejects.toThrow("Follow-up session generation was replaced during admission");
    expect(sessionStore.main).toBeUndefined();
    expect(operation.complete).toHaveBeenCalledOnce();
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

    const result = await admitFollowupTurn({
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
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(deniedEntry);
    state.resolveSendPolicy.mockImplementation(({ entry }) =>
      entry === deniedEntry ? "deny" : "allow",
    );
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("end");
      return deniedEntry;
    });

    await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      onCompactionNoticePayload,
    });

    expect(onCompactionNoticePayload).not.toHaveBeenCalled();
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
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      sessionStore.main = rotatedEntry;
      await onCompactionNotice?.("end");
      return rotatedEntry;
    });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      onCompactionNoticePayload,
    });

    expect(result).toMatchObject({ kind: "admitted" });
    expect(onCompactionNoticePayload).toHaveBeenCalledWith(
      { text: "end" },
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
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("end");
      return initialEntry;
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry }),
        onCompactionNoticePayload: vi.fn(async () => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("delivers an incomplete terminal notice after ordinary preflight failure", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("start");
      await onCompactionNotice?.("incomplete");
      throw new Error("preflight failed");
    });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry }),
      onCompactionNoticePayload,
    });

    expect(result).toMatchObject({ kind: "admitted", turn: { preflightFailurePayload: {} } });
    expect(onCompactionNoticePayload).toHaveBeenCalledTimes(2);
    expect(onCompactionNoticePayload).toHaveBeenNthCalledWith(
      1,
      { text: "start" },
      expect.anything(),
    );
    expect(onCompactionNoticePayload).toHaveBeenNthCalledWith(
      2,
      { text: "incomplete" },
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

    const result = await admitFollowupTurn({
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

  it("restores the item when generation changes before a compaction notice", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const replacementEntry: SessionEntry = { sessionId: "replacement-session", updatedAt: 2 };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(replacementEntry);
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("end");
      return initialEntry;
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
        onCompactionNoticePayload,
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(onCompactionNoticePayload).not.toHaveBeenCalled();
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("cancels preflight immediately when the start notice sees invalidation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const replacementEntry: SessionEntry = { sessionId: "replacement-session", updatedAt: 2 };
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(replacementEntry);
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      try {
        await onCompactionNotice?.("start");
      } catch {
        // The memory owner logs notice failures; the abort signal stops its compactor.
      }
      throw new Error("compaction aborted");
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(operation.abortForRestart).toHaveBeenCalledOnce();
    expect(operation.complete).toHaveBeenCalledOnce();
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
      const result = await admitFollowupTurn({
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
    const result = await admitFollowupTurn({ queued: createRun(), defaults: createDefaults() });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: { preflightFailurePayload: { text: userMessage } },
    });
    expect(state.buildPreflightFailureText).not.toHaveBeenCalled();
  });
});
