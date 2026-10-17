import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import type { SessionEntry } from "../../config/sessions.js";
import { clearCommandLane, enqueueCommandInLane } from "../../process/command-queue.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { baseParams } from "./get-reply-run.test-support.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
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

async function createAdmissionFixture() {
  const sessionKey = "agent:main:slack:channel:room:thread:100.1";
  const sessionId = "session";
  const entry: SessionEntry = { sessionId, updatedAt: 1 };
  const body = "Use the revised request";
  const selected = { provider: "anthropic", model: "claude" };
  const ctx = { Body: body, SessionKey: sessionKey, Provider: "slack", ChatType: "channel" };
  const params = baseParams({
    ctx,
    sessionCtx: ctx,
    conversation: { fields: ctx, group: {} },
    cfg: {},
    agentId: "main",
    directives: parseInlineSessionDirectives(body),
    modelState: createModelSelectionStateFixture({ agentCfg: {}, ...selected }),
    ...selected,
    typing: createTypingController({}),
    defaultModel: selected.model,
    isNewSession: false,
    sessionKey,
    sessionId,
    storePath: "/tmp/agent/sessions/sessions.json",
    sessionStore: { [sessionKey]: entry },
    resolvedThinkLevel: "off",
    sessionEntry: entry,
  });
  params.command.rawBodyNormalized = body;
  params.command.commandBodyNormalized = body;
  const context = await prepareReplyRunContext(params);
  if (context?.kind !== "ready") {
    throw new Error("Expected a prepared reply context");
  }
  return {
    context: { ...context, useFastReplyRuntime: false, thinkingRuntime: "embedded" as const },
    entry,
    sessionKey,
    sessionId,
  };
}

afterEach(() => vi.clearAllMocks());

it("carries an inherited thinking request through admission to candidate selection", async () => {
  const { context, entry } = await createAdmissionFixture();
  entry.thinkingLevel = "high";
  const catalog = [{ provider: "fixture", id: "basic", name: "Basic", reasoning: false }];
  const result = await prepareReplyRunAdmission({
    ...context,
    thinkingRuntime: "openclaw",
    params: {
      ...context.params,
      provider: "fixture",
      model: "basic",
      resolvedThinkLevel: "high",
      modelState: {
        ...context.params.modelState,
        allowedModelCatalog: catalog,
        resolveThinkingCatalog: async () => catalog,
      },
    },
  });

  expect(result).toMatchObject({ kind: "ready", resolvedThinkLevel: "high" });
  expect(entry.thinkingLevel).toBe("high");
});

it.each([
  { sessionKey: "global", agentId: "research" },
  { sessionKey: undefined, agentId: "main" },
])("interrupt clears only owned work for $agentId/$sessionKey", async ({ sessionKey, agentId }) => {
  const { context, entry, sessionId } = await createAdmissionFixture();
  const lane = resolveEmbeddedSessionLane(sessionKey ?? sessionId);
  const entered = createDeferred();
  const release = createDeferred();
  const blocker = enqueueCommandInLane(lane, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const queue = (value: string, target?: { agentId: string; sessionId: string }) =>
    enqueueCommandInLane(lane, async () => value, {
      sessionTarget: target && sessionKey ? { ...target, sessionKey } : undefined,
    });
  const queued = sessionKey
    ? [
        queue("main", { agentId: "main", sessionId: "main-session" }),
        queue("untagged"),
        queue("research", { agentId, sessionId }),
        queue("older research", { agentId, sessionId: "older-session" }),
      ]
    : [queue("queued")];
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
});

it.each(["steer", "followup"] as const)(
  "preserves %s admission and transcript authority despite an older queued followup",
  async (mode) => {
    const { context, sessionKey, sessionId } = await createAdmissionFixture();
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
        preparedSessionState: { sessionFile: sessionKey },
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
    const { context, entry } = await createAdmissionFixture();
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
