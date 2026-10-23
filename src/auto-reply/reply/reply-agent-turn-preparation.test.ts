import { assert, beforeEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { bindIngressLifecycleToReplyOptions } from "../../channels/message/ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import {
  createRuntimeConfigReader,
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import { SessionWorkStartError } from "../../config/sessions/session-work-start.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import { releaseSessionControllerClaim } from "../../sessions/session-controller.mailbox.js";
import * as configuredOwners from "../../state/user-channel-identity-operations.js";
import {
  bindCommandOwnerAuthority,
  captureCommandOwnerAssertion,
} from "../command-owner-authority.js";
import type { FollowupRun } from "./queue/types.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createPreparationRun } from "./reply-agent-turn-preparation.test-support.js";
import { resolveReplyToolAuthorityContext } from "./reply-tool-authority.js";
import type { ScheduledSessionAutomation } from "./session-event-contract.js";

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
  resolveRunAfterAutoFallbackPrimaryProbeRecheck: state.recheckFallbackProbe,
}));

vi.mock("./agent-runner-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-memory.js")>()),
  runSessionCompactionIfNeeded: state.preflight,
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: state.resolveConfig,
}));

// mock-isolation: Preparation cases supply an owned or rejected turn without admitting a second real controller operation.
vi.mock("./reply-turn-admission.js", () => ({ admitReplyTurn: state.admitReply }));

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
  resolveSendPolicy: state.resolveSendPolicy,
}));

vi.mock("./inbound-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-meta.js")>()),
  refreshActiveGoalContext: state.refreshGoal,
}));

vi.mock("./compaction-notice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./compaction-notice.js")>()),
  createCompactionNoticePayload: ({ phase }: { phase: string }) => ({ text: phase }),
  shouldNotifyUserAboutCompaction: () => state.shouldNotifyCompaction,
}));

vi.mock("./agent-runner-failure-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-failure-reply.js")>()),
  buildPreflightCompactionFailureText: state.buildPreflightFailureText,
}));

const { prepareReplyAgentTurn } = await import("./reply-agent-turn-preparation.js");

let operation: ReturnType<typeof createOperation>;
beforeEach(() => {
  vi.clearAllMocks();
  operation = createOperation();
  admit(operation);
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

function resolveAdmittedToolAuthority(turn: AdmittedFollowupTurn) {
  const { run } = turn.queued;
  return resolveReplyToolAuthorityContext(
    turn.queued,
    undefined,
    resolvePreparedSandboxRuntimeStatus({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      preparedSessionEntry: turn.session.current() ?? null,
    }),
    {}, // These admission fixtures have no persisted parent capability lineage.
  );
}

function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return createPreparationRun({
    prompt: "queued prompt",
    ...overrides,
    run: {
      sessionId: "queued-session",
      sessionKey: "main",
      sessionFile: "/tmp/queued.jsonl",
      provider: "anthropic",
      model: "claude",
      ...overrides.run,
    },
  });
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

function prepare(
  queued = createRun(),
  defaults: Partial<Parameters<typeof prepareReplyAgentTurn>[0]["defaults"]> = {},
  options: Omit<Partial<Parameters<typeof prepareReplyAgentTurn>[0]>, "queued" | "defaults"> = {},
) {
  return prepareReplyAgentTurn({
    queued,
    defaults: {
      typing: {} as never,
      typingMode: "never",
      defaultModel: "claude",
      sessionKey: "main",
      ...defaults,
    },
    ...options,
  });
}

async function admitted(result: ReturnType<typeof prepare>) {
  const prepared = await result;
  assert(prepared.kind === "admitted");
  return prepared.turn;
}

function admit(
  ownedOperation: ReplyOperation | ReturnType<typeof createOperation>,
  preparedEntry?: SessionEntry,
) {
  state.admitReply.mockResolvedValue({
    status: "owned",
    operation: ownedOperation,
    sessionEntry: preparedEntry,
  });
}

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "queued-session", updatedAt: 1, ...overrides };
}

function sessionFixture(
  initialEntry = makeEntry(),
  admittedEntry: SessionEntry | null = initialEntry,
  owner: Parameters<typeof admit>[0] = operation,
) {
  const sessionStore = { main: initialEntry };
  admit(owner, admittedEntry ?? undefined);
  return {
    initialEntry,
    sessionStore,
    start: (
      defaults: Parameters<typeof prepare>[1] = {},
      queued = createRun(),
      options: Parameters<typeof prepare>[2] = {},
    ) =>
      admitted(prepare(queued, { sessionEntry: initialEntry, sessionStore, ...defaults }, options)),
  };
}

function compactionFixture(stored = false) {
  const session = sessionFixture(makeEntry(stored ? { lifecycleRevision: "initial" } : {}));
  const rotatedEntry = makeEntry({
    sessionId: "compacted-session",
    lifecycleRevision: "compacted",
    updatedAt: 2,
  });
  const onCompactionNotice = vi.fn(async () => {});
  state.shouldNotifyCompaction = true;
  return {
    ...session,
    rotatedEntry,
    onCompactionNotice,
    start: (defaults: Parameters<typeof prepare>[1] = {}) =>
      session.start(
        { sessionStore: stored ? session.sessionStore : undefined, ...defaults },
        createRun(),
        { onCompactionNotice },
      ),
  };
}

function emitNotices(entry: SessionEntry, phases = ["end"], failure?: Error) {
  state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
    for (const phase of phases) {
      await onCompactionNotice?.(phase);
    }
    if (failure) {
      throw failure;
    }
    return entry;
  });
}

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

it("retains an undefined preflight rejection as an executable failure", async () => {
  state.preflight.mockRejectedValueOnce(undefined);

  const { preflightError } = await admitted(prepare());
  expect(preflightError).toBeInstanceOf(Error);
  expect(preflightError).toMatchObject({ message: "Reply preparation failed", cause: undefined });
});

it("reports a queued event's admission refusal to its source before consuming it", async () => {
  const error = new SessionWorkStartError("archived", "Restore this session before retrying.");
  state.admitReply.mockResolvedValue({ status: "skipped", reason: "lifecycle-invalidated", error });
  const queued = createRun();
  const onFailed = vi.fn();
  queued.run.internalEventExecution = { onStarted: vi.fn(), onTerminal: vi.fn(), onFailed };

  await expect(prepare(queued)).resolves.toEqual({
    kind: "skipped",
    reason: "lifecycle-invalidated",
  });
  expect(onFailed).toHaveBeenCalledExactlyOnceWith(error);
  expect(state.preflight).not.toHaveBeenCalled();
});

it.each([
  { match: "sender-id", enqueuedOwner: false },
  { match: "sender-id", enqueuedOwner: true },
  { match: "sender-e164", enqueuedOwner: false },
  { match: "sender-e164", enqueuedOwner: true },
] as const)(
  "resolves $match owner privileges at the admission fence after enqueue owner=$enqueuedOwner",
  async ({ match, enqueuedOwner }) => {
    const queued = createRun();
    const channel = match === "sender-e164" ? "whatsapp" : "telegram";
    const senderId = match === "sender-e164" ? "123456789@lid" : "alice";
    const senderE164 = match === "sender-e164" ? "+15555550123" : undefined;
    const configuredOwner = `${channel}:${senderE164 ?? senderId}`;
    const otherOwner = `${channel}:other`;
    const originalConfig = {
      commands: { ownerAllowFrom: [enqueuedOwner ? configuredOwner : otherOwner] },
    };
    const admittedOwner = !enqueuedOwner;
    const admittedConfig = {
      commands: { ownerAllowFrom: [admittedOwner ? configuredOwner : otherOwner] },
    };
    const laterConfig = { ...admittedConfig, tools: { deny: ["message"] } };
    const durableOwnerRead = vi
      .spyOn(configuredOwners, "prepareConfiguredCommandOwnerAuthority")
      .mockResolvedValue(undefined);
    setRuntimeConfigSnapshot(originalConfig, originalConfig);
    queued.run.config = originalConfig;
    queued.readAdmissionConfig = createRuntimeConfigReader(originalConfig);
    queued.run.requesterOrigin = {
      sessionKey: `agent:original:${channel}:direct:${senderId}`,
      messageProvider: channel,
      accountId: "work",
      senderId,
      senderE164,
    };
    queued.run.senderId = "receiver";
    queued.run.senderIsOwner = enqueuedOwner;
    queued.run.traceAuthorized = enqueuedOwner;
    bindCommandOwnerAuthority(queued.run, { isCurrent: () => enqueuedOwner });
    state.admitReply.mockImplementation(async ({ captureRunSelection }) => {
      // The actual admission owner invokes this fence again after waiting for a direct command.
      setRuntimeConfigSnapshot(admittedConfig, admittedConfig);
      captureRunSelection();
      setRuntimeConfigSnapshot(laterConfig, laterConfig);
      return { status: "owned", operation };
    });
    try {
      const turn = await admitted(prepare(queued));
      const execution = turn.queued;
      expect(execution.run).toMatchObject({
        config: admittedConfig,
        requesterOrigin: { senderId, senderE164 },
        senderIsOwner: admittedOwner,
        traceAuthorized: admittedOwner,
      });
      expect(execution.run.config).toEqual(admittedConfig);
      expect(resolveAdmittedToolAuthority(turn).capabilityProfile.sender.isOwner).toBe(
        admittedOwner,
      );
      const assertOwner = captureCommandOwnerAssertion(execution.run);
      if (admittedOwner) {
        expect(assertOwner).toBeDefined();
        expect(assertOwner).not.toThrow();
        setRuntimeConfigSnapshot({ commands: { ownerAllowFrom: [] } });
      }
      expect(assertOwner).toThrow("Channel operator authority changed");
      expect(queued.run).toMatchObject({
        requesterOrigin: { senderId, senderE164 },
        senderIsOwner: enqueuedOwner,
      });
      expect(queued.run.config).toBe(originalConfig);
    } finally {
      durableOwnerRead.mockRestore();
      clearRuntimeConfigSnapshot();
    }
  },
);

it.each([false, true])(
  "preserves operator precedence only while custody is live, revoked=%s",
  async (revoked) => {
    const queued = createRun();
    const controller = new AbortController();
    const assertCurrent = vi.fn(() => controller.signal.throwIfAborted());
    queued.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: revoked ? "alice" : "alice-profile",
      scopes: ["operator.admin"],
      assertCurrent,
      signal: controller.signal,
    });
    queued.run.requesterOrigin = {
      sessionKey: revoked ? "main" : "agent:original:telegram:direct:alice",
      messageProvider: "telegram",
      senderId: "alice",
      ...(!revoked && { operatorProfileId: "alice-profile" }),
    };
    queued.run.senderIsOwner = true;
    if (revoked) {
      state.resolveConfig.mockImplementation(async (config) => {
        controller.abort(new Error("operator source retired"));
        return config;
      });
      await expect(prepare(queued)).rejects.toThrow("operator source retired");
      expect(state.admitReply).toHaveBeenCalledOnce();
      expect(operation.complete).toHaveBeenCalledOnce();
      expect(state.preflight).not.toHaveBeenCalled();
    } else {
      queued.run.config = { commands: { ownerAllowFrom: ["telegram:other"] } };
      queued.run.traceAuthorized = true;
      using durableOwnerRead = vi
        .spyOn(configuredOwners, "prepareConfiguredCommandOwnerAuthority")
        .mockResolvedValue(undefined);
      const turn = await admitted(prepare(queued));
      expect(turn.queued.run).toMatchObject({ senderIsOwner: true, traceAuthorized: true });
      expect(resolveAdmittedToolAuthority(turn).capabilityProfile.sender.isOwner).toBe(true);
      expect(assertCurrent).toHaveBeenCalled();
      expect(durableOwnerRead).not.toHaveBeenCalled();
    }
  },
);
it.each([
  "paused",
  "blocked",
  "complete",
  "budget_limited",
  "usage_limited",
  "replaced",
  "cleared",
  "new input",
  "paused during preflight",
] as const)("drops an automatic Goal nudge when admission observes %s", async (change) => {
  const original = createActiveGoalEntry();
  const onQueuedFollowupAdmitted = vi.fn(async () => {});
  const onQueuedFollowupSettled = vi.fn(async () => {});
  let current = change === "paused during preflight" ? original : structuredClone(original);
  if (change === "replaced") {
    current.goal!.id = "replacement";
  } else if (change === "cleared") {
    current.goal = undefined;
  } else if (change === "new input") {
    state.queueDepth.mockReturnValue(1);
  } else if (change === "paused during preflight") {
    state.preflight.mockImplementation(async () => {
      current = {
        ...original,
        updatedAt: 2,
        goal: { ...original.goal!, status: "paused", updatedAt: 2 },
      };
      return original;
    });
  } else {
    current.goal!.status = change;
  }
  admit(operation, change === "paused during preflight" ? original : current);
  state.loadEntry.mockImplementation(() => current);
  const result = await prepare(
    createRun({ goalContinuation: { sessionId: "queued-session", goalId: "goal" } }),
    {
      sessionEntry: original,
      storePath: "/fixture/sessions.json",
      opts: { onQueuedFollowupAdmitted, onQueuedFollowupSettled },
    },
  );
  expect(result).toMatchObject({ kind: "skipped", reason: "goal-inactive", operation });
  expect(onQueuedFollowupAdmitted).toHaveBeenCalledOnce();
  expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
  expect(operation.complete).not.toHaveBeenCalled();
  expect(state.preflight).toHaveBeenCalledTimes(change === "paused during preflight" ? 1 : 0);
});

it("preserves the admitted legacy transcript target", async () => {
  const queued = createRun();
  queued.run.sessionKey = undefined;
  queued.run.sessionFile = "legacy-target";
  admit(createOperation("admitted-session"));

  const turn = await admitted(prepare(queued, { sessionKey: undefined }));
  expect(turn.queued.run.sessionFile).toBe("legacy-target");
});

it("retires a selected source refused by reply admission without adopting it", async () => {
  state.admitReply.mockResolvedValue({ status: "skipped", reason: "active-run" });
  const onAdopted = vi.fn();
  const queued = createRun({ turnAdoptionLifecycle: { onAdopted } });

  await expect(prepare(queued)).resolves.toEqual({
    kind: "skipped",
    reason: "lifecycle-invalidated",
  });
  expect(releaseSessionControllerClaim).toHaveBeenCalledOnce();
  expect(onAdopted).not.toHaveBeenCalled();
});

it("stops when reply admission aborts the queued source", async () => {
  const controller = new AbortController();
  state.admitReply.mockImplementation(async () => {
    controller.abort();
    return { status: "owned", operation };
  });

  await expect(prepare(createRun({ queueAbortSignal: controller.signal }))).resolves.toMatchObject({
    kind: "skipped",
    reason: "aborted",
    operation,
  });
  expect(state.preflight).not.toHaveBeenCalled();
});

it("keeps ingress retryable when queued preparation fails before input acceptance", async () => {
  vi.useFakeTimers();
  try {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const failure = new Error("ENOSPC: queued turn preparation failed");
      await queue.enqueue("queued-input", { text: "Please answer this message" });
      const drain = createChannelIngressDrain({
        queue,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await prepare(createRun(bindIngressLifecycleToReplyOptions(lifecycle)), {
            opts: {
              onQueuedFollowupAdmitted: async () => {
                throw failure;
              },
            },
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
  operation = createOperation("admitted-session");
  const entry = makeEntry({
    sessionId: operation.sessionId,
    modelSelectionLocked: true,
    updatedAt: 2,
  });
  const { start } = sessionFixture(makeEntry(), entry);
  const onQueuedFollowupAdmitted = vi.fn(async () => {});
  const queued = createRun({
    currentInboundContext: { text: "stale goal" },
    originatingChatType: "group",
  });
  state.loadEntry.mockReturnValue(entry);
  state.sendPolicy = "deny";
  state.refreshGoal.mockReturnValue({ text: "fresh goal" });
  const turn = await start(
    { storePath: "/tmp/sessions.json", opts: { onQueuedFollowupAdmitted } },
    queued,
  );
  expect(turn.queued.run).toMatchObject({
    sessionId: "admitted-session",
    sessionFile: "main",
    modelSelectionLocked: true,
  });
  expect(turn.queued.currentInboundContext).toEqual({ text: "fresh goal" });
  expect(turn.sendPolicy).toBe("deny");
  expect(turn.session.current()).toBe(entry);
  expect(onQueuedFollowupAdmitted).toHaveBeenCalledOnce();
  expect(state.resolveSendPolicy).toHaveBeenCalledWith(
    expect.objectContaining({ chatType: "group" }),
  );
});

it("clears queued generation facts when only the lifecycle revision advances", async () => {
  const initial = makeEntry({ lifecycleRevision: "queued-revision" });
  const entry = makeEntry({ lifecycleRevision: "admitted-revision", updatedAt: 2 });
  const { start } = sessionFixture(initial, entry);
  state.loadEntry.mockReturnValue(entry);
  const queued = createRun();
  queued.run.cliSessionBindingFacts = { provider: "claude-cli" } as never;
  queued.run.autoFallbackPrimaryProbe = { provider: "anthropic", model: "claude" } as never;
  const turn = await start({}, queued);
  expect(turn.queued.run).toMatchObject({
    cliSessionBindingFacts: undefined,
    autoFallbackPrimaryProbe: undefined,
  });
});

it("does not pass stale enqueue-time state into a rotated session generation", async () => {
  operation = createOperation("rotated-session");
  const { start } = sessionFixture(makeEntry({ modelSelectionLocked: true }), null);
  state.loadEntry.mockReturnValue(undefined);
  const turn = await start();
  expect(turn.queued.run.modelSelectionLocked).toBe(false);
  expect(state.preflight).toHaveBeenCalledWith(
    expect.objectContaining({ sessionEntry: undefined }),
  );
  const preflightParams: { sessionStore?: Record<string, SessionEntry> } =
    state.preflight.mock.calls[0]?.[0];
  expect(preflightParams.sessionStore?.main).toBeUndefined();
  expect(state.refreshGoal).toHaveBeenCalledWith(undefined, undefined);
});

it("settles presentation and releases the reply operation when dispatcher setup fails", async () => {
  const failure = new Error("dispatcher reset failed");
  const onQueuedFollowupSettled = vi.fn(async () => {});

  await expect(
    prepare(createRun(), {
      opts: {
        onQueuedFollowupAdmitted: vi.fn().mockRejectedValue(failure),
        onQueuedFollowupSettled,
      },
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

  const turn = await admitted(
    prepare(queued, {
      opts: {
        onQueuedFollowupAdmitted: async () => {
          queued.run.model = "next-turn-model";
        },
      },
    }),
  );
  expect(turn.queued.run.model).toBe("selected-at-admission");
  expect(queued.run.model).toBe("next-turn-model");
});

it("takes only the scheduled fallback policy selected at admission", async () => {
  const policy = (sessionModelOverrideSource?: "user") => ({
    useSubagentFallbacks: false,
    inheritDefaultFallbacksForAgentStringModel: false,
    sessionModelOverrideSource,
  });
  const scheduled = (job: string, sessionModelOverrideSource?: "user") =>
    ({
      occurrence: TEST_SCHEDULED_OCCURRENCE,
      job: { id: job } as ScheduledSessionAutomation["job"],
      admissionSource: "operator-schedule",
      assertCurrent: () => {},
      modelFallbackPolicy: policy(sessionModelOverrideSource),
    }) satisfies ScheduledSessionAutomation;
  const enqueued = scheduled("enqueued", "user");
  const atAdmission = scheduled("other");
  const queued = createRun();
  queued.run.scheduledAutomation = enqueued;
  const ordinary = createRun();
  // Settings writers replace the waiting source's policy; an ordinary run must not gain one.
  for (const source of [queued, ordinary]) {
    state.admitReply.mockImplementationOnce(async ({ captureRunSelection }) => {
      source.run.scheduledAutomation = atAdmission;
      captureRunSelection();
      return { status: "owned", operation: createOperation() };
    });
  }

  const { run } = (
    await admitted(
      prepare(queued, {
        opts: {
          onQueuedFollowupAdmitted: async () => {
            queued.run.scheduledAutomation = scheduled("later", "user");
          },
        },
      }),
    )
  ).queued;
  expect(run.scheduledAutomation?.modelFallbackPolicy).toBe(atAdmission.modelFallbackPolicy);
  // The occurrence's job and authority keep the bindings the turn was enqueued with.
  expect(run.scheduledAutomation?.job).toBe(enqueued.job);
  expect(run.scheduledAutomation?.assertCurrent).toBe(enqueued.assertCurrent);
  expect((await admitted(prepare(ordinary))).queued.run.scheduledAutomation).toBeUndefined();
});

it("refreshes send policy and goal context after preflight rotates the generation", async () => {
  const { initialEntry, start } = sessionFixture();
  const rotatedEntry = makeEntry({ sessionId: "compacted-session", updatedAt: 2 });
  state.loadEntry.mockReturnValue(initialEntry);
  state.refreshGoal.mockImplementation((_context, entry) => ({ text: entry?.sessionId }));
  state.preflight.mockImplementation(async () => {
    state.sendPolicy = "deny";
    return rotatedEntry;
  });

  const turn = await start({}, createRun({ currentInboundContext: { text: "stale" } }));
  expect(turn).toMatchObject({
    sendPolicy: "deny",
    queued: { currentInboundContext: { text: "compacted-session" } },
  });
});

it("rechecks send policy before an in-preflight compaction notice", async () => {
  const { initialEntry, onCompactionNotice, start } = compactionFixture();
  const deniedEntry: SessionEntry = { ...initialEntry, updatedAt: 2 };
  state.loadEntry.mockReturnValue(deniedEntry);
  state.resolveSendPolicy.mockImplementation(({ entry }) =>
    entry === deniedEntry ? "deny" : "allow",
  );
  emitNotices(deniedEntry);

  await start({ storePath: "/tmp/sessions.json" });

  expect(onCompactionNotice).not.toHaveBeenCalled();
  expect(state.resolveSendPolicy).toHaveBeenLastCalledWith(
    expect.objectContaining({ entry: deniedEntry }),
  );
});

it.each([false, true])(
  "adopts a preflight rotation before completion, failure=%s",
  async (fails) => {
    const { rotatedEntry, sessionStore, onCompactionNotice, start } = compactionFixture(true);
    state.preflight.mockImplementation(
      async ({ onCompactionNotice: emitCompactionNotice, sessionStore: ownedStore }) => {
        if (fails) {
          ownedStore.main = rotatedEntry;
          throw new Error("preflight failed after rotation");
        }
        sessionStore.main = rotatedEntry;
        await emitCompactionNotice?.("end");
        return rotatedEntry;
      },
    );
    const turn = await start();
    if (fails) {
      expect(turn).toMatchObject({
        queued: { run: { sessionId: "compacted-session" } },
        preflightFailurePayload: {},
      });
      expect(operation.updateSessionId).toHaveBeenCalledWith("compacted-session");
    } else {
      const noticeTurn = {
        sendPolicy: "allow",
        queued: { run: { sessionId: "compacted-session" } },
      };
      expect(onCompactionNotice.mock.calls[0]).toMatchObject(["end", undefined, noticeTurn]);
    }
  },
);

it("releases the admitted operation when deferred terminal notice delivery fails", async () => {
  const { initialEntry, onCompactionNotice, start } = compactionFixture();
  const failure = new Error("notice delivery failed");
  emitNotices(initialEntry);
  onCompactionNotice.mockRejectedValue(failure);

  await expect(start()).rejects.toBe(failure);
  expect(operation.complete).toHaveBeenCalledOnce();
});

it("delivers an incomplete terminal notice after ordinary preflight failure", async () => {
  const { initialEntry, onCompactionNotice, start } = compactionFixture();
  emitNotices(initialEntry, ["start", "incomplete"], new Error("preflight failed"));

  const turn = await start();
  expect(turn).toMatchObject({ preflightFailurePayload: {} });
  expect(onCompactionNotice.mock.calls).toEqual([
    ["start", undefined, expect.anything()],
    ["incomplete", undefined, expect.anything()],
  ]);
});

it("keeps preflight failure cancellation live while refreshing send policy", async () => {
  const upstreamAbort = new AbortController();
  const replyOperation = createReplyOperation({
    sessionKey: "agent:main:queued-preflight-cancel",
    sessionId: "queued-session",
    resetTriggered: false,
    upstreamAbortSignal: upstreamAbort.signal,
  });
  const { start } = sessionFixture(makeEntry(), undefined, replyOperation);
  state.preflight.mockImplementation(async () => {
    state.sendPolicy = "deny";
    throw new Error("preflight failed");
  });

  try {
    const turn = await start();
    expect(turn).toMatchObject({
      sendPolicy: "deny",
      preflightFailurePayload: { text: "preflight failed" },
    });
    upstreamAbort.abort(new Error("source canceled before input acceptance"));
    expect(replyOperation.abortSignal.aborted).toBe(true);
  } finally {
    replyOperation.complete();
  }
});

it("retains the preflight owner's public recovery guidance for a queued turn", async () => {
  const userMessage = "The saved history exceeds its limit. Use /new, then resend your message.";
  state.preflight.mockRejectedValue(
    new AgentHarnessPreflightError("private diagnostic", { userMessage }),
  );
  const turn = await admitted(prepare());
  expect(turn).toMatchObject({ preflightFailurePayload: { text: userMessage } });
});
