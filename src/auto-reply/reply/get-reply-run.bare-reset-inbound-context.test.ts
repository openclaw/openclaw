import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

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

vi.mock("../../agents/spawned-context.js", () => ({
  resolveIngressWorkspaceOverrideForSpawnedRun: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./session-reset-prompt.js", () => ({
  resolveBareSessionResetPromptState: vi
    .fn()
    .mockResolvedValue({ prompt: "", shouldPrependStartupContext: false }),
  resolveBareResetBootstrapFileAccess: vi.fn().mockReturnValue(false),
}));

vi.mock("./startup-context.js", () => ({
  shouldApplyStartupContext: vi.fn().mockReturnValue(false),
  buildSessionStartupContextPrelude: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../config/sessions/group.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
}));

const updateSessionStore = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions/store.runtime.js", () => ({
  updateSessionStore,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock(import("../../routing/session-key.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    normalizeMainKey: () => "main",
    normalizeAgentId: (id: string | undefined | null) => id ?? "default",
  };
});

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("./agent-runner.runtime.js", () => ({
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

const applySessionHints = vi.hoisted(() =>
  vi.fn().mockImplementation(async ({ baseBody }: { baseBody: string }) => baseBody),
);

vi.mock("./body.js", () => ({
  applySessionHints,
}));

vi.mock("./groups.js", () => ({
  buildDirectChatContext: vi.fn().mockReturnValue(""),
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
  resolveGroupSilentReplyBehavior: vi.fn(
    (params: {
      sessionEntry?: SessionEntry;
      defaultActivation: "always" | "mention";
      silentReplyPolicy?: "allow" | "disallow";
      silentReplyRewrite?: boolean;
    }) => {
      const activation = params.sessionEntry?.groupActivation ?? params.defaultActivation;
      const canUseSilentReply =
        params.silentReplyPolicy !== "disallow" || params.silentReplyRewrite === true;
      return {
        activation,
        canUseSilentReply,
        allowEmptyAssistantReplyAsSilent: params.silentReplyPolicy === "allow",
      };
    },
  ),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi
    .fn()
    .mockReturnValue("[Group history]\nAlice: hey there\nBob: anyone around?"),
}));

vi.mock("./queue/settings-runtime.js", () => ({
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
let replyRunTesting: typeof import("./reply-run-registry.js").__testing;

function bareResetParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  return {
    ctx: {
      Body: "",
      RawBody: "",
      CommandBody: "",
      ThreadHistoryBody: "",
      OriginatingChannel: "lark",
      OriginatingTo: "G123",
      ChatType: "group",
    },
    sessionCtx: {
      Body: "",
      BodyStripped: "",
      InboundHistory: [
        { sender: "Alice", body: "Alice: hey there" },
        { sender: "Bob", body: "Bob: anyone around?" },
      ],
      Provider: "lark",
      ChatType: "group",
      OriginatingChannel: "lark",
      OriginatingTo: "G123",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "lark",
      channel: "lark",
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
      rawBodyNormalized: "/reset",
      commandBodyNormalized: "/reset",
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
      resolveThinkingCatalog: async () => [],
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
    resetTriggered: true,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    ...overrides,
  };
}

describe("runPreparedReply isBareSessionReset carries inboundUserContext (#71520 follow-up)", () => {
  beforeAll(async () => {
    ({ runPreparedReply } = await import("./get-reply-run.js"));
    ({ __testing: replyRunTesting } = await import("./reply-run-registry.js"));
  });

  beforeEach(async () => {
    updateSessionStore.mockReset();
    vi.clearAllMocks();
    replyRunTesting.resetReplyRunRegistry();
  });

  it("includes group InboundHistory in the prompt body on a bare session reset", async () => {
    await runPreparedReply(bareResetParams());

    expect(applySessionHints).toHaveBeenCalledTimes(1);
    const baseBody = applySessionHints.mock.calls.at(-1)?.[0]?.baseBody as string;
    expect(baseBody).toContain("[Group history]");
    expect(baseBody).toContain("Alice: hey there");
    expect(baseBody).toContain("Bob: anyone around?");
  });

  it("does not duplicate inboundUserContext when the non-reset path runs", async () => {
    await runPreparedReply(
      bareResetParams({
        isNewSession: false,
        resetTriggered: false,
      }),
    );

    expect(applySessionHints).toHaveBeenCalledTimes(1);
    const baseBody = applySessionHints.mock.calls.at(-1)?.[0]?.baseBody as string;
    const occurrences = baseBody.split("[Group history]").length - 1;
    expect(occurrences).toBe(1);
  });
});
