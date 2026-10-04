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

afterEach(() => vi.clearAllMocks());

describe("prepared reply transcript identity", () => {
  it.each([
    { sessionKey: "global", agentId: "research" },
    { sessionKey: undefined, agentId: "main" },
  ])(
    "interrupt clears only owned work for $agentId/$sessionKey",
    async ({ sessionKey, agentId }) => {
      const { context, entry, sessionId } = createAdmissionFixture();
      const lane = resolveEmbeddedSessionLane(sessionKey ?? sessionId);
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = enqueueCommandInLane(lane, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = sessionKey
        ? [
            enqueueCommandInLane(lane, async () => "main", {
              sessionTarget: { agentId: "main", sessionKey, sessionId: "main-session" },
            }),
            enqueueCommandInLane(lane, async () => "untagged"),
            enqueueCommandInLane(lane, async () => "research", {
              sessionTarget: { agentId, sessionKey, sessionId },
            }),
            enqueueCommandInLane(lane, async () => "older research", {
              sessionTarget: { agentId, sessionKey, sessionId: "older-session" },
            }),
          ]
        : [enqueueCommandInLane(lane, async () => "queued")];
      const followup = createQueueTestRun({ prompt: "preserved research followup" });
      if (sessionKey) {
        Object.assign(followup.run, { agentId, sessionKey, sessionId });
        enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false);
      }
      const results = Promise.allSettled(queued);
      try {
        const prepared = await prepareReplyRunAdmission({
          ...context,
          effectiveQueueMode: "interrupt",
          runtimePolicySessionKey: sessionKey,
          promptSessionCtx: sessionKey
            ? context.promptSessionCtx
            : { ...context.promptSessionCtx, SessionKey: undefined },
          params: {
            ...context.params,
            agentId,
            sessionKey,
            sessionStore: sessionKey ? { [sessionKey]: entry } : undefined,
            ctx: { ...context.params.ctx, SessionKey: sessionKey },
            sessionCtx: { ...context.params.sessionCtx, SessionKey: sessionKey },
          },
        });
        expect(prepared.kind).toBe("ready");
        if (sessionKey) {
          expect(getExistingFollowupQueue(sessionKey)?.items).toEqual([followup]);
        } else {
          expect(drainFormattedSystemEvents).not.toHaveBeenCalled();
        }
        release.resolve();
        await blocker;
        const cleared = {
          status: "rejected",
          reason: expect.objectContaining({ name: "CommandLaneClearedError" }),
        };
        expect(await results).toEqual(
          sessionKey
            ? [
                { status: "fulfilled", value: "main" },
                { status: "fulfilled", value: "untagged" },
                cleared,
                cleared,
              ]
            : [cleared],
        );
      } finally {
        release.resolve();
        clearCommandLane(lane);
        if (sessionKey) {
          clearFollowupQueue(sessionKey);
        }
        await Promise.allSettled([blocker, results]);
      }
    },
  );

  it.each(["steer", "followup"] as const)(
    "preserves %s admission and transcript authority despite an older queued followup",
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
            sessionFile: resolveAdmittedRunSessionFile(incoming.run)!,
          },
        };
        expect(resolveFollowupRunToolAuthorityFingerprint(incoming)).toBe(
          resolveFollowupRunToolAuthorityFingerprint(queued),
        );
        expect(prepared.preparedSessionState.sessionFile).toBe(sessionKey);
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
});
