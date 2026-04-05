import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";
import type { SessionEntry } from "../../config/sessions/types.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/pi-embedded.runtime.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../config/sessions/group.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
}));

const storeRuntimeLoads = vi.hoisted(() => vi.fn());
const updateSessionStore = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions/store.runtime.js", () => {
  storeRuntimeLoads();
  return {
    updateSessionStore,
  };
});

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn().mockReturnValue("main"),
  normalizeAgentId: vi.fn((id?: string) => id ?? "default"),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("./agent-runner.runtime.js", () => ({
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn().mockImplementation(async ({ baseBody }) => baseBody),
}));

vi.mock("./groups.js", () => ({
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
}));

vi.mock("./queue/settings.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "followup" }),
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: vi.fn(),
}));

vi.mock("./session-updates.runtime.js", () => ({
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
}));

vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

let runPreparedReply: typeof import("./get-reply-run.js").runPreparedReply;
let runReplyAgent: typeof import("./agent-runner.runtime.js").runReplyAgent;
let routeReply: typeof import("./route-reply.runtime.js").routeReply;
let drainFormattedSystemEvents: typeof import("./session-system-events.js").drainFormattedSystemEvents;
let resolveTypingMode: typeof import("./typing-mode.js").resolveTypingMode;
let getActiveEmbeddedRunCount: typeof import("../../agents/pi-embedded-runner/runs.js").getActiveEmbeddedRunCount;
let abortEmbeddedPiRun: typeof import("../../agents/pi-embedded-runner/runs.js").abortEmbeddedPiRun;
let clearActiveEmbeddedRun: typeof import("../../agents/pi-embedded-runner/runs.js").clearActiveEmbeddedRun;
let isEmbeddedPiRunActiveActual: typeof import("../../agents/pi-embedded-runner/runs.js").isEmbeddedPiRunActive;
let moveActiveEmbeddedRun: typeof import("../../agents/pi-embedded-runner/runs.js").moveActiveEmbeddedRun;
let resolveActiveEmbeddedRunSessionIdActual: typeof import("../../agents/pi-embedded-runner/runs.js").resolveActiveEmbeddedRunSessionId;
let setActiveEmbeddedRun: typeof import("../../agents/pi-embedded-runner/runs.js").setActiveEmbeddedRun;
let runsTesting: typeof import("../../agents/pi-embedded-runner/runs.js").__testing;
let resetActiveEmbeddedRuns: typeof import("../../agents/pi-embedded-runner/runs.js").__testing.resetActiveEmbeddedRuns;
let loadScopeCounter = 0;

function createGatewayDrainingError(): Error {
  const error = new Error("Gateway is draining for restart; new tasks are not accepted");
  error.name = "GatewayDrainingError";
  return error;
}

async function loadFreshGetReplyRunModuleForTest() {
  ({ runPreparedReply } = await importFreshModule<typeof import("./get-reply-run.js")>(
    import.meta.url,
    `./get-reply-run.js?scope=media-only-${loadScopeCounter++}`,
  ));
}

function baseParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  return {
    ctx: {
      Body: "",
      RawBody: "",
      CommandBody: "",
      ThreadHistoryBody: "Earlier message in this thread",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
      ChatType: "group",
    },
    sessionCtx: {
      Body: "",
      BodyStripped: "",
      ThreadHistoryBody: "Earlier message in this thread",
      MediaPath: "/tmp/input.png",
      Provider: "slack",
      ChatType: "group",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "slack",
      channel: "slack",
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
      rawBodyNormalized: "",
      commandBodyNormalized: "",
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: {
      hasThinkDirective: false,
      thinkLevel: undefined,
    } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    ...overrides,
  };
}

describe("runPreparedReply media-only handling", () => {
  beforeAll(async () => {
    ({ runReplyAgent } = await import("./agent-runner.runtime.js"));
    ({ routeReply } = await import("./route-reply.runtime.js"));
    ({ drainFormattedSystemEvents } = await import("./session-system-events.js"));
    ({ resolveTypingMode } = await import("./typing-mode.js"));
    ({
      __testing: runsTesting,
      getActiveEmbeddedRunCount,
      abortEmbeddedPiRun,
      clearActiveEmbeddedRun,
      isEmbeddedPiRunActive: isEmbeddedPiRunActiveActual,
      moveActiveEmbeddedRun,
      resolveActiveEmbeddedRunSessionId: resolveActiveEmbeddedRunSessionIdActual,
      setActiveEmbeddedRun,
    } = await import("../../agents/pi-embedded-runner/runs.js"));
    resetActiveEmbeddedRuns = () => {
      runsTesting.resetActiveEmbeddedRuns();
    };
  });

  beforeEach(async () => {
    storeRuntimeLoads.mockClear();
    updateSessionStore.mockReset();
    vi.clearAllMocks();
    resetActiveEmbeddedRuns();
    await loadFreshGetReplyRunModuleForTest();
  });

  it("does not load session store runtime on module import", async () => {
    await loadFreshGetReplyRunModuleForTest();

    expect(storeRuntimeLoads).not.toHaveBeenCalled();
  });

  it("allows media-only prompts and preserves thread context in queued followups", async () => {
    const result = await runPreparedReply(baseParams());
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("keeps thread history context on follow-up turns", async () => {
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
      }),
    );
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
  });

  it("returns the empty-body reply when there is no text and no media", async () => {
    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "slack",
        },
      }),
    );

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("does not send a standalone reset notice for reply-producing /new turns", async () => {
    await runPreparedReply(
      baseParams({
        resetTriggered: true,
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.replyOperation?.resetTriggered).toBe(true);
    expect(vi.mocked(routeReply)).not.toHaveBeenCalled();
  });

  it("does not emit a reset notice when /new is attempted during gateway drain", async () => {
    vi.mocked(runReplyAgent).mockRejectedValueOnce(createGatewayDrainingError());

    await expect(
      runPreparedReply(
        baseParams({
          resetTriggered: true,
        }),
      ),
    ).rejects.toThrow("Gateway is draining for restart; new tasks are not accepted");

    expect(vi.mocked(routeReply)).not.toHaveBeenCalled();
  });

  it("does not register a reply operation before auth setup succeeds", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const sessionId = "reply-operation-auth-failure";
    const activeBefore = getActiveEmbeddedRunCount();
    vi.mocked(resolveSessionAuthProfileOverride).mockRejectedValueOnce(new Error("auth failed"));

    await expect(
      runPreparedReply(
        baseParams({
          sessionId,
        }),
      ),
    ).rejects.toThrow("auth failed");

    expect(getActiveEmbeddedRunCount()).toBe(activeBefore);
    abortEmbeddedPiRun(sessionId);
  });
  it("waits for the previous active run to clear before registering a new reply operation", async () => {
    const oldAbort = vi.fn();
    const oldHandle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: () => true,
      isCompacting: () => false,
      abort: oldAbort,
    };
    setActiveEmbeddedRun("session-overlap", oldHandle, "session-key");

    let resolveWait!: (value: boolean) => void;
    const waitPromise = new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });

    const piRuntime = await import("../../agents/pi-embedded.runtime.js");
    vi.mocked(piRuntime.abortEmbeddedPiRun).mockReturnValueOnce(true);
    vi.mocked(piRuntime.isEmbeddedPiRunActive).mockReturnValue(true);
    vi.mocked(piRuntime.isEmbeddedPiRunStreaming).mockReturnValue(false);
    vi.mocked(piRuntime.waitForEmbeddedPiRunEnd).mockImplementationOnce(
      async () => await waitPromise,
    );
    const queueSettings = await import("./queue/settings.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-overlap",
      }),
    );

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
    expect(abortEmbeddedPiRun("session-overlap")).toBe(true);
    expect(oldAbort).toHaveBeenCalledTimes(1);

    clearActiveEmbeddedRun("session-overlap", oldHandle, "session-key");
    resolveWait(true);

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("rechecks same-session ownership after async prep before registering a new reply operation", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const piRuntime = await import("../../agents/pi-embedded.runtime.js");
    const queueSettings = await import("./queue/settings.js");

    let resolveAuth!: () => void;
    const authPromise = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });
    let resolveWait!: (value: boolean) => void;
    const waitPromise = new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });
    const intruderAbort = vi.fn();
    const intruderHandle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: () => true,
      isCompacting: () => false,
      abort: intruderAbort,
    };

    vi.mocked(resolveSessionAuthProfileOverride).mockImplementationOnce(
      async () => await authPromise.then(() => undefined),
    );
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(piRuntime.isEmbeddedPiRunActive).mockImplementation((sessionId) =>
      isEmbeddedPiRunActiveActual(sessionId),
    );
    vi.mocked(piRuntime.isEmbeddedPiRunStreaming).mockReturnValue(false);
    vi.mocked(piRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation((sessionKey) =>
      resolveActiveEmbeddedRunSessionIdActual(sessionKey),
    );
    vi.mocked(piRuntime.waitForEmbeddedPiRunEnd).mockImplementationOnce(
      async () => await waitPromise,
    );

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-auth-race",
      }),
    );

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();

    setActiveEmbeddedRun("session-auth-race", intruderHandle, "session-key");
    resolveAuth();

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
    expect(abortEmbeddedPiRun("session-auth-race")).toBe(true);
    expect(intruderAbort).toHaveBeenCalledTimes(1);

    clearActiveEmbeddedRun("session-auth-race", intruderHandle, "session-key");
    resolveWait(true);

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("re-resolves same-session ownership after session-id rotation during async prep", async () => {
    const { resolveSessionAuthProfileOverride } =
      await import("../../agents/auth-profiles/session-override.js");
    const piRuntime = await import("../../agents/pi-embedded.runtime.js");
    const queueSettings = await import("./queue/settings.js");

    let resolveAuth!: () => void;
    const authPromise = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });
    let resolveWait!: (value: boolean) => void;
    const waitPromise = new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });
    const rotatedHandle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": {
        sessionId: "session-before-rotation",
        sessionFile: "/tmp/session-before-rotation.jsonl",
        updatedAt: 1,
      },
    };

    vi.mocked(resolveSessionAuthProfileOverride).mockImplementationOnce(
      async () => await authPromise.then(() => undefined),
    );
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(piRuntime.isEmbeddedPiRunActive).mockImplementation((sessionId) =>
      isEmbeddedPiRunActiveActual(sessionId),
    );
    vi.mocked(piRuntime.isEmbeddedPiRunStreaming).mockReturnValue(false);
    vi.mocked(piRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation((sessionKey) =>
      resolveActiveEmbeddedRunSessionIdActual(sessionKey),
    );
    vi.mocked(piRuntime.waitForEmbeddedPiRunEnd).mockImplementationOnce(
      async () => await waitPromise,
    );

    const runPromise = runPreparedReply(
      baseParams({
        isNewSession: false,
        sessionId: "session-before-rotation",
        sessionEntry: sessionStore["session-key"],
        sessionStore,
      }),
    );

    await Promise.resolve();
    setActiveEmbeddedRun("session-before-rotation", rotatedHandle, "session-key");
    sessionStore["session-key"] = {
      ...sessionStore["session-key"],
      sessionId: "session-after-rotation",
      sessionFile: "/tmp/session-after-rotation.jsonl",
      updatedAt: 2,
    };
    expect(
      moveActiveEmbeddedRun({
        fromSessionId: "session-before-rotation",
        toSessionId: "session-after-rotation",
        handle: rotatedHandle,
        fromSessionKey: "session-key",
        toSessionKey: "session-key",
      }),
    ).toBe(true);

    resolveAuth();

    await Promise.resolve();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(piRuntime.waitForEmbeddedPiRunEnd)).toHaveBeenCalledWith(
      "session-after-rotation",
    );

    clearActiveEmbeddedRun("session-after-rotation", rotatedHandle, "session-key");
    resolveWait(true);

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call?.followupRun.run.sessionId).toBe("session-after-rotation");
  });
  it("uses inbound origin channel for run messageProvider", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:abc",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "telegram",
          ChatType: "group",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.messageProvider).toBe("webchat");
  });

  it("prefers Provider over Surface when origin channel is missing", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
          Provider: "feishu",
          Surface: "webchat",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "webchat",
          ChatType: "group",
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.messageProvider).toBe("feishu");
  });

  it("uses the effective session account for followup originatingAccountId when AccountId is omitted", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:24680",
          ChatType: "group",
          AccountId: undefined,
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "discord",
          ChatType: "group",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:24680",
          AccountId: "work",
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.originatingAccountId).toBe("work");
  });

  it("passes suppressTyping through typing mode resolution", async () => {
    await runPreparedReply(
      baseParams({
        opts: {
          suppressTyping: true,
        },
      }),
    );

    const call = vi.mocked(resolveTypingMode).mock.calls[0]?.[0] as
      | { suppressTyping?: boolean }
      | undefined;
    expect(call?.suppressTyping).toBe(true);
  });

  it("routes queued system events into user prompt text, not system prompt context", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Model switched.");

    await runPreparedReply(baseParams());

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.commandBody).toContain("System: [t] Model switched.");
    expect(call?.followupRun.run.extraSystemPrompt ?? "").not.toContain("Runtime System Events");
  });

  it("preserves first-token think hint when system events are prepended", async () => {
    // drainFormattedSystemEvents returns just the events block; the caller prepends it.
    // The hint must be extracted from the user body BEFORE prepending, so "System:"
    // does not shadow the low|medium|high shorthand.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    await runPreparedReply(
      baseParams({
        ctx: { Body: "low tell me about cats", RawBody: "low tell me about cats" },
        sessionCtx: { Body: "low tell me about cats", BodyStripped: "low tell me about cats" },
        resolvedThinkLevel: undefined,
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    // Think hint extracted before events arrived — level must be "low", not the model default.
    expect(call?.followupRun.run.thinkLevel).toBe("low");
    // The stripped user text (no "low" token) must still appear after the event block.
    expect(call?.commandBody).toContain("tell me about cats");
    expect(call?.commandBody).not.toMatch(/^low\b/);
    // System events are still present in the body.
    expect(call?.commandBody).toContain("System: [t] Node connected.");
  });

  it("carries system events into followupRun.prompt for deferred turns", async () => {
    // drainFormattedSystemEvents returns the events block; the caller prepends it to
    // effectiveBaseBody for the queue path so deferred turns see events.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    await runPreparedReply(baseParams());

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("System: [t] Node connected.");
  });

  it("does not strip think-hint token from deferred queue body", async () => {
    // In steer mode the inferred thinkLevel is never consumed, so the first token
    // must not be stripped from the queue/steer body (followupRun.prompt).
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(undefined);

    await runPreparedReply(
      baseParams({
        ctx: { Body: "low steer this conversation", RawBody: "low steer this conversation" },
        sessionCtx: {
          Body: "low steer this conversation",
          BodyStripped: "low steer this conversation",
        },
        resolvedThinkLevel: undefined,
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    // Queue body (used by steer mode) must keep the full original text.
    expect(call?.followupRun.prompt).toContain("low steer this conversation");
  });
});
