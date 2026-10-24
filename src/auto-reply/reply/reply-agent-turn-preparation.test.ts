import { assert, beforeEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
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
type PrepareParams = Parameters<typeof prepareReplyAgentTurn>[0];
type Defaults = Partial<PrepareParams["defaults"]>;
type Options = Omit<Partial<PrepareParams>, "queued" | "defaults">;

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

function prepare(queued = createRun(), defaults: Defaults = {}, options: Options = {}) {
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
    start: (defaults: Defaults = {}, queued = createRun(), options: Options = {}) =>
      admitted(prepare(queued, { sessionEntry: initialEntry, sessionStore, ...defaults }, options)),
  };
}

function createActiveGoalEntry(): SessionEntry {
  return makeEntry({
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
  });
}

it.each([
  {
    name: "undefined rejection",
    error: undefined,
    expected: { preflightError: { message: "Reply preparation failed", cause: undefined } },
  },
  {
    name: "public recovery guidance",
    error: new AgentHarnessPreflightError("private diagnostic", {
      userMessage: "Use /new, then resend your message.",
    }),
    expected: { preflightFailurePayload: { text: "Use /new, then resend your message." } },
  },
])("retains $name from preflight", async ({ error, expected }) => {
  state.preflight.mockRejectedValueOnce(error);
  const turn = await admitted(prepare());
  expect(turn.preflightError).toBeInstanceOf(Error);
  expect(turn).toMatchObject(expected);
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
  { match: "sender-e164", enqueuedOwner: false },
  { match: "sender-e164", enqueuedOwner: true },
] as const)(
  "resolves $match owner privileges at the admission fence after enqueue owner=$enqueuedOwner",
  async ({ match, enqueuedOwner }) => {
    const queued = createRun();
    const channel = match === "sender-e164" ? "whatsapp" : "telegram";
    const senderId = match === "sender-e164" ? "123456789@lid" : "alice";
    const senderE164 = match === "sender-e164" ? "+15555550123" : undefined;
    const ownerConfig = (owner: boolean) => ({
      commands: {
        ownerAllowFrom: [`${channel}:${owner ? (senderE164 ?? senderId) : "other"}`],
      },
    });
    const originalConfig = ownerConfig(enqueuedOwner);
    const admittedOwner = !enqueuedOwner;
    const admittedConfig = ownerConfig(admittedOwner);
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
      setRuntimeConfigSnapshot(admittedConfig, admittedConfig);
      captureRunSelection();
      setRuntimeConfigSnapshot({ ...admittedConfig, tools: { deny: ["message"] } });
      return { status: "owned", operation };
    });
    try {
      const turn = await admitted(prepare(queued));
      const execution = turn.queued;
      expect(execution.run).toMatchObject({
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
    queued.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "alice-profile",
      scopes: ["operator.admin"],
      assertCurrent: () => controller.signal.throwIfAborted(),
      signal: controller.signal,
    });
    queued.run.requesterOrigin = {
      sessionKey: "agent:original:telegram:direct:alice",
      messageProvider: "telegram",
      senderId: "alice",
      operatorProfileId: "alice-profile",
    };
    queued.run.senderIsOwner = true;
    if (revoked) {
      state.resolveConfig.mockImplementation(async (config) => {
        controller.abort(new Error("operator source retired"));
        return config;
      });
      await expect(prepare(queued)).rejects.toThrow("operator source retired");
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
      expect(durableOwnerRead).not.toHaveBeenCalled();
    }
  },
);
it.each(["paused", "new input", "paused during preflight"] as const)(
  "drops an automatic Goal nudge when admission observes %s",
  async (change) => {
    const original = createActiveGoalEntry();
    const onQueuedFollowupAdmitted = vi.fn(async () => {});
    const onQueuedFollowupSettled = vi.fn(async () => {});
    let current = change === "paused during preflight" ? original : structuredClone(original);
    if (change === "new input") {
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
  },
);

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

it.each(["admitted", "revision", "missing", "legacy"] as const)(
  "projects the %s session generation without stale enqueue state",
  async (kind) => {
    const initial = makeEntry({ lifecycleRevision: "old", modelSelectionLocked: true });
    operation = createOperation(kind === "revision" ? initial.sessionId : "admitted-session");
    const entry =
      kind === "missing"
        ? null
        : makeEntry({
            sessionId: operation.sessionId,
            lifecycleRevision: "new",
            modelSelectionLocked: true,
          });
    const { start } = sessionFixture(initial, entry);
    const queued = createRun({ currentInboundContext: { text: "stale" } });
    queued.run.cliSessionBindingFacts = { provider: "claude-cli" } as never;
    queued.run.autoFallbackPrimaryProbe = { provider: "anthropic", model: "claude" } as never;
    state.loadEntry.mockReturnValue(entry ?? undefined);
    state.sendPolicy = "deny";
    state.refreshGoal.mockImplementation((_context, current) =>
      current ? { text: "fresh" } : undefined,
    );
    if (kind === "legacy") {
      queued.run.sessionKey = undefined;
      queued.run.sessionFile = "legacy-target";
    }
    const turn = await start({ sessionKey: kind === "legacy" ? undefined : "main" }, queued);
    expect(turn.queued.run).toMatchObject({
      sessionId: operation.sessionId,
      sessionFile: kind === "legacy" ? "legacy-target" : "main",
      modelSelectionLocked: kind !== "missing",
      cliSessionBindingFacts: undefined,
      autoFallbackPrimaryProbe: undefined,
    });
    expect(turn.queued.currentInboundContext).toEqual(entry ? { text: "fresh" } : undefined);
    expect(turn.sendPolicy).toBe("deny");
    if (kind === "missing") {
      const preflight = state.preflight.mock.calls[0]?.[0];
      expect([preflight.sessionEntry, preflight.sessionStore?.main]).toEqual([
        undefined,
        undefined,
      ]);
    } else if (kind !== "legacy") {
      expect(turn.session.current()).toBe(entry);
    }
  },
);

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
      source.run.model = "selected-at-admission";
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
            queued.run.model = "next-turn-model";
          },
        },
      }),
    )
  ).queued;
  expect(run.model).toBe("selected-at-admission");
  expect(queued.run.model).toBe("next-turn-model");
  expect(run.scheduledAutomation?.modelFallbackPolicy).toBe(atAdmission.modelFallbackPolicy);
  // The occurrence's job and authority keep the bindings the turn was enqueued with.
  expect(run.scheduledAutomation?.job).toBe(enqueued.job);
  expect(run.scheduledAutomation?.assertCurrent).toBe(enqueued.assertCurrent);
  expect((await admitted(prepare(ordinary))).queued.run.scheduledAutomation).toBeUndefined();
});

it.each([
  "rotate",
  "rotate denied",
  "rotate failed",
  "policy recheck",
  "notice failed",
  "preflight failed",
])("settles compaction with %s", async (scenario) => {
  const rotates = scenario.startsWith("rotate");
  const denies =
    scenario === "rotate denied" || scenario === "rotate failed" || scenario === "policy recheck";
  const { initialEntry, sessionStore, start } = sessionFixture();
  const finalEntry = makeEntry({
    sessionId: rotates ? "compacted-session" : initialEntry.sessionId,
    updatedAt: 2,
  });
  const notice = vi.fn<NonNullable<Options["onCompactionNotice"]>>(async () => {});
  const failure = new Error("preflight failed");
  state.shouldNotifyCompaction = true;
  state.loadEntry.mockReturnValue(finalEntry);
  state.refreshGoal.mockImplementation((_context, entry) => ({ text: entry?.sessionId }));
  state.resolveSendPolicy.mockImplementation(({ entry }) =>
    entry === finalEntry && denies ? "deny" : "allow",
  );
  state.preflight.mockImplementation(async ({ onCompactionNotice, sessionStore: ownedStore }) => {
    if (rotates) {
      ownedStore.main = finalEntry;
      sessionStore.main = finalEntry;
    }
    if (scenario === "rotate failed") {
      throw failure;
    }
    if (scenario === "preflight failed") {
      await onCompactionNotice?.("start");
      await onCompactionNotice?.("incomplete");
      throw failure;
    }
    await onCompactionNotice?.("end");
    return finalEntry;
  });
  if (scenario === "notice failed") {
    notice.mockRejectedValue(failure);
  }
  const result = start(
    {
      sessionStore: rotates ? sessionStore : undefined,
      storePath: scenario === "policy recheck" ? "/tmp/sessions.json" : undefined,
    },
    createRun(),
    { onCompactionNotice: notice },
  );
  if (scenario === "notice failed") {
    await expect(result).rejects.toBe(failure);
    expect(operation.complete).toHaveBeenCalledOnce();
    return;
  }
  const turn = await result;
  if (rotates) {
    expect(turn).toMatchObject({
      sendPolicy: denies ? "deny" : "allow",
      queued: {
        run: { sessionId: "compacted-session" },
        currentInboundContext: { text: "compacted-session" },
      },
    });
  }
  if (scenario.endsWith("failed")) {
    expect(turn.preflightFailurePayload).toMatchObject({ text: "preflight failed" });
  }
  if (denies) {
    expect(notice).not.toHaveBeenCalled();
  } else if (scenario === "preflight failed") {
    expect(notice.mock.calls.map(([phase]) => phase)).toEqual(["start", "incomplete"]);
  } else {
    expect(notice.mock.calls[0]?.[2].queued.run.sessionId).toBe(finalEntry.sessionId);
  }
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
