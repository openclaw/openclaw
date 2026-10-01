import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import type { SessionEntry } from "../../config/sessions.js";
import { clearCommandLane, enqueueCommandInLane } from "../../process/command-queue.js";
import { resolveAdmittedRunSessionFile } from "./agent-runner-core.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import type { PreparedReplyRunContext } from "./get-reply-run-context.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import { createTypingController } from "./typing.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: vi.fn(async () => undefined),
}));
vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: vi.fn(async () => undefined),
}));
vi.mock("./queue/drain.js", () => ({
  clearFollowupDrainCallback: () => {},
  scheduleFollowupDrain: () => {
    throw new Error("Admission fixture must not start a drain");
  },
  kickFollowupDrainIfIdle: () => {
    throw new Error("Admission fixture must not start a drain");
  },
}));
vi.mock("./get-reply-run-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./get-reply-run-helpers.js")>()),
  loadAgentRunnerRuntime: async () => ({ runReplyAgent: vi.fn() }),
  loadEmbeddedAgentRuntime: async () => ({
    resolveActiveEmbeddedRunSessionId: () => undefined,
    resolveActiveEmbeddedRunSessionIdBySessionFile: () => undefined,
    resolveEmbeddedSessionLane,
  }),
  loadSessionUpdatesRuntime: async () => ({
    ensureSkillSnapshot: async ({ sessionEntry }: { sessionEntry: SessionEntry }) => ({
      sessionEntry,
    }),
  }),
}));

function createAdmissionFixture() {
  const sessionKey = "agent:main:slack:channel:room:thread:100.1";
  const sessionId = "session";
  const entry: SessionEntry = { sessionId, updatedAt: 1 };
  const ctx = { SessionKey: sessionKey, Provider: "slack", ChatType: "channel" };
  const body = "Use the revised request";
  const context: PreparedReplyRunContext = {
    kind: "ready",
    params: {
      ctx,
      sessionCtx: ctx,
      conversation: { fields: ctx, group: {} },
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: {},
      sessionCfg: {},
      commandAuthorized: true,
      command: {
        surface: "slack",
        channel: "slack",
        ownerList: [],
        senderIsOwner: false,
        isAuthorizedSender: true,
        rawBodyNormalized: body,
        commandBodyNormalized: body,
      },
      allowTextCommands: true,
      directives: parseInlineSessionDirectives(body),
      defaultActivation: "always",
      modelState: createModelSelectionStateFixture({
        agentCfg: {},
        provider: "anthropic",
        model: "claude",
      }),
      provider: "anthropic",
      model: "claude",
      typing: createTypingController({}),
      defaultModel: "claude",
      timeoutMs: 30_000,
      isNewSession: false,
      resetTriggered: false,
      systemSent: true,
      sessionKey,
      sessionId,
      storePath: "/tmp/agent/sessions/sessions.json",
      sessionStore: { [sessionKey]: entry },
      workspaceDir: "/tmp/workspace",
      abortedLastRun: false,
      resolvedThinkLevel: "off",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      elevatedEnabled: false,
      elevatedAllowed: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
    },
    runtimePolicySessionKey: sessionKey,
    isHeartbeat: false,
    explicitThinkingLevelOverride: undefined,
    effectiveQueueMode: undefined,
    promptSessionCtx: ctx,
    inboundEventKind: undefined,
    sourceReplyDeliveryMode: undefined,
    silentReplyPromptMode: "none",
    fullAccessState: { available: false },
    isFirstTurnInSession: false,
    extraSystemPromptParts: [],
    sourceConversationContextByMode: { automatic: "", message_tool_only: "" },
    sourceConversationContextPromptOffset: undefined,
    extraSystemPromptStatic: "",
    cliSessionBindingFacts: { extraSystemPromptStatic: "" },
    baseBodyTrimmedRaw: body,
    effectiveResetTriggered: false,
    isBareSessionReset: false,
    startupAction: "new",
    startupContextPrelude: null,
    softResetTail: "",
    shouldInjectGroupIntro: false,
    typingMode: "never",
    isMainSession: false,
    inboundUserContextPromptJoiner: undefined,
    terminalReplyExpectation: "optional",
    sessionEntry: entry,
    traceRunPhase: async <T>(_name: string, run: () => T | Promise<T>) => await run(),
    baseBodyFinal: body,
    prefixedBodyBase: body,
    hasUserBody: true,
    workspaceDir: "/tmp/workspace",
    skillsWorkspaceDir: "/tmp/workspace",
    useFastReplyRuntime: false,
    thinkingRuntime: "embedded",
    getInboundContext: () => ({ activeGoalContext: undefined, inboundUserContext: "" }),
    refreshInboundContextAfterAdmissionWait: async () => {},
  };
  return { context, entry, sessionKey, sessionId };
}

// Exercise the producer before execution: queued admission later normalizes the
// same transcript to its scoped key, which must not change tool authority.
afterEach(() => vi.clearAllMocks());

describe("prepared reply transcript identity", () => {
  it("interrupt preserves another agent's tagged and untagged global lane work", async () => {
    const { context, entry } = createAdmissionFixture();
    const sessionKey = "global";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = enqueueCommandInLane(lane, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const foreign = enqueueCommandInLane(lane, async () => "main", {
      sessionTarget: { agentId: "main", sessionKey, sessionId: "main-session" },
    });
    const untagged = enqueueCommandInLane(lane, async () => "untagged");
    const owned = enqueueCommandInLane(lane, async () => "research", {
      sessionTarget: { agentId: "research", sessionKey, sessionId: entry.sessionId },
    });
    const older = enqueueCommandInLane(lane, async () => "older research", {
      sessionTarget: { agentId: "research", sessionKey, sessionId: "older-session" },
    });
    const followup = createQueueTestRun({ prompt: "preserved research followup" });
    Object.assign(followup.run, { agentId: "research", sessionKey, sessionId: entry.sessionId });
    enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false);
    const results = Promise.allSettled([foreign, untagged, owned, older]);
    try {
      const prepared = await prepareReplyRunAdmission({
        ...context,
        effectiveQueueMode: "interrupt",
        runtimePolicySessionKey: sessionKey,
        params: {
          ...context.params,
          agentId: "research",
          sessionKey,
          sessionStore: { [sessionKey]: entry },
          ctx: { ...context.params.ctx, SessionKey: sessionKey },
          sessionCtx: { ...context.params.sessionCtx, SessionKey: sessionKey },
        },
      });
      expect(prepared.kind).toBe("ready");
      expect(getExistingFollowupQueue(sessionKey)?.items).toEqual([followup]);
      release.resolve();
      await blocker;
      expect(await results).toEqual([
        { status: "fulfilled", value: "main" },
        { status: "fulfilled", value: "untagged" },
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "CommandLaneClearedError" }),
        },
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "CommandLaneClearedError" }),
        },
      ]);
    } finally {
      release.resolve();
      clearCommandLane(lane);
      clearFollowupQueue(sessionKey);
      await Promise.allSettled([blocker, results]);
    }
  });

  it("interrupt clears a keyless run's own sessionId lane", async () => {
    const { context, sessionId } = createAdmissionFixture();
    const lane = resolveEmbeddedSessionLane(sessionId);
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = enqueueCommandInLane(lane, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const queued = enqueueCommandInLane(lane, async () => "queued");
    const result = Promise.allSettled([queued]);
    try {
      const prepared = await prepareReplyRunAdmission({
        ...context,
        effectiveQueueMode: "interrupt",
        runtimePolicySessionKey: undefined,
        promptSessionCtx: { ...context.promptSessionCtx, SessionKey: undefined },
        params: {
          ...context.params,
          sessionKey: undefined,
          sessionStore: undefined,
          ctx: { ...context.params.ctx, SessionKey: undefined },
          sessionCtx: { ...context.params.sessionCtx, SessionKey: undefined },
        },
      });
      expect(prepared.kind).toBe("ready");
      expect(drainFormattedSystemEvents).not.toHaveBeenCalled();
      release.resolve();
      await blocker;
      expect(await result).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "CommandLaneClearedError" }),
        },
      ]);
    } finally {
      release.resolve();
      clearCommandLane(lane);
      await Promise.allSettled([blocker, result]);
    }
  });

  it.each(["steer", "followup"] as const)(
    "keeps %s admission independent of an older queued followup",
    async (mode) => {
      const { context, sessionKey, sessionId } = createAdmissionFixture();
      const older = createQueueTestRun({ prompt: "Earlier followup", messageId: `older-${mode}` });
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      operation.setPhase("running");
      enqueueFollowupRun(sessionKey, older, { mode: "followup" }, "message-id", undefined, false);
      try {
        const prepared = await prepareReplyRunAdmission({ ...context, effectiveQueueMode: mode });
        expect(prepared).toMatchObject({
          kind: "ready",
          isActive: true,
          shouldSteer: mode === "steer",
          shouldFollowup: true,
        });
        expect(getExistingFollowupQueue(sessionKey)?.items).toEqual([older]);
      } finally {
        operation.complete();
        clearFollowupQueue(sessionKey);
      }
    },
  );

  it.each([false, true])(
    "keeps caller-only model auth selection off the shared session (fast=%s)",
    async (fast) => {
      const { context, entry } = createAdmissionFixture();
      entry.authProfileOverride = "fixture:shared";
      entry.authProfileOverrideSource = "user";
      vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(async (params) => {
        expect(params.storePath).toBeUndefined();
        expect(params.sessionEntry).not.toBe(entry);
        if (!params.sessionEntry) {
          throw new Error("Expected an auth selection snapshot");
        }
        params.sessionEntry.authProfileOverride = "fixture:turn";
        return { profileId: "fixture:turn", source: "auto", routeRequirement: undefined };
      });

      const result = await prepareReplyRunAdmission({
        ...context,
        useFastReplyRuntime: fast,
        params: {
          ...context.params,
          provider: "fixture",
          model: "allowed",
          modelState: { ...context.params.modelState, operatorModelOverride: true },
        },
      });
      expect(result).toMatchObject({ kind: "ready", authProfileId: "fixture:turn" });
      expect(resolveSessionAuthSelection).toHaveBeenCalledOnce();
      expect(entry.authProfileOverride).toBe("fixture:shared");
    },
  );

  it("keeps incoming authority identical when the active turn came from the queue", async () => {
    const { context, sessionKey, sessionId } = createAdmissionFixture();
    const prepared = await prepareReplyRunAdmission(context);
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") {
      throw new Error("Expected a prepared reply");
    }
    const incoming = createQueueTestRun({ prompt: "Use the revised request" });
    incoming.run = {
      ...incoming.run,
      agentId: "main",
      sessionKey,
      sessionId,
      sessionFile: prepared.preparedSessionState.sessionFile,
    };
    const queued = {
      ...incoming,
      run: {
        ...incoming.run,
        sessionFile: resolveAdmittedRunSessionFile({
          sessionKey: incoming.run.sessionKey,
          sessionFile: incoming.run.sessionFile,
        })!,
      },
    };
    expect(resolveFollowupRunToolAuthorityFingerprint(incoming)).toBe(
      resolveFollowupRunToolAuthorityFingerprint(queued),
    );
    expect(prepared.preparedSessionState.sessionFile).toBe(sessionKey);
  });
});
