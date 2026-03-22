import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import type { MsgContext, TemplateContext } from "../templating.js";

const createEmptyDirectives = (cleaned = "") => ({
  cleaned,
  hasThinkDirective: false,
  thinkLevel: undefined,
  rawThinkLevel: undefined,
  hasVerboseDirective: false,
  verboseLevel: undefined,
  rawVerboseLevel: undefined,
  hasFastDirective: false,
  fastMode: undefined,
  rawFastMode: undefined,
  hasReasoningDirective: false,
  reasoningLevel: undefined,
  rawReasoningLevel: undefined,
  hasElevatedDirective: false,
  elevatedLevel: undefined,
  rawElevatedLevel: undefined,
  hasExecDirective: false,
  execHost: undefined,
  execSecurity: undefined,
  execAsk: undefined,
  execNode: undefined,
  rawExecHost: undefined,
  rawExecSecurity: undefined,
  rawExecAsk: undefined,
  rawExecNode: undefined,
  hasExecOptions: false,
  invalidExecHost: false,
  invalidExecSecurity: false,
  invalidExecAsk: false,
  invalidExecNode: false,
  hasStatusDirective: false,
  hasModelDirective: false,
  rawModelDirective: undefined,
  hasQueueDirective: false,
  queueMode: undefined,
  queueReset: false,
  rawQueueMode: undefined,
  debounceMs: undefined,
  cap: undefined,
  dropPolicy: undefined,
  rawDebounce: undefined,
  rawCap: undefined,
  rawDrop: undefined,
  hasQueueOptions: false,
});

const mocks = vi.hoisted(() => ({
  resolveFastModeState: vi.fn(() => ({ enabled: false })),
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
  listChatCommands: vi.fn(() => []),
  shouldHandleTextCommands: vi.fn(() => false),
  listSkillCommandsForWorkspace: vi.fn(() => []),
  resolveBlockStreamingChunking: vi.fn(() => ({
    minChars: 800,
    maxChars: 1200,
    breakPreference: "paragraph" as const,
  })),
  buildCommandContext: vi.fn(() => ({
    surface: "telegram",
    isAuthorizedSender: true,
  })),
  parseInlineDirectives: vi.fn((text: string) => createEmptyDirectives(text)),
  applyInlineDirectiveOverrides: vi.fn(
    async (params: {
      directives: ReturnType<typeof createEmptyDirectives>;
      provider: string;
      model: string;
      contextTokens: number;
    }) => ({
      directives: params.directives,
      provider: params.provider,
      model: params.model,
      contextTokens: params.contextTokens,
    }),
  ),
  defaultGroupActivation: vi.fn(() => "mention"),
  resolveGroupRequireMention: vi.fn(() => true),
  stripMentions: vi.fn((text: string) => text),
  stripStructuralPrefixes: vi.fn((text: string) => text),
  createModelSelectionState: vi.fn(async () => ({
    provider: "sub2api",
    model: "gpt-5.4",
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    resolveDefaultThinkingLevel: vi.fn(async () => undefined),
    resolveDefaultReasoningLevel: vi.fn(async () => "off" as const),
    needsModelCatalog: false,
  })),
  resolveContextTokens: vi.fn(() => 32000),
  formatElevatedUnavailableMessage: vi.fn(() => "elevated unavailable"),
  resolveElevatedPermissions: vi.fn(() => ({
    enabled: true,
    allowed: true,
    failures: [],
  })),
  stripInlineStatus: vi.fn((text: string) => ({ cleaned: text })),
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: mocks.resolveFastModeState,
}));
vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: mocks.resolveSandboxRuntimeStatus,
}));
vi.mock("../commands-registry.js", () => ({
  listChatCommands: mocks.listChatCommands,
  shouldHandleTextCommands: mocks.shouldHandleTextCommands,
}));
vi.mock("../skill-commands.js", () => ({
  listSkillCommandsForWorkspace: mocks.listSkillCommandsForWorkspace,
}));
vi.mock("./block-streaming.js", () => ({
  resolveBlockStreamingChunking: mocks.resolveBlockStreamingChunking,
}));
vi.mock("./commands.js", () => ({
  buildCommandContext: mocks.buildCommandContext,
}));
vi.mock("./directive-handling.js", () => ({
  parseInlineDirectives: mocks.parseInlineDirectives,
}));
vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: mocks.applyInlineDirectiveOverrides,
}));
vi.mock("./get-reply-directives-utils.js", () => ({
  clearExecInlineDirectives: vi.fn(
    (directives: ReturnType<typeof createEmptyDirectives>) => directives,
  ),
  clearInlineDirectives: vi.fn((cleaned: string) => createEmptyDirectives(cleaned)),
}));
vi.mock("./groups.js", () => ({
  defaultGroupActivation: mocks.defaultGroupActivation,
  resolveGroupRequireMention: mocks.resolveGroupRequireMention,
}));
vi.mock("./mentions.js", () => ({
  CURRENT_MESSAGE_MARKER: "__CURRENT_MESSAGE__",
  stripMentions: mocks.stripMentions,
  stripStructuralPrefixes: mocks.stripStructuralPrefixes,
}));
vi.mock("./model-selection.js", () => ({
  createModelSelectionState: mocks.createModelSelectionState,
  resolveContextTokens: mocks.resolveContextTokens,
}));
vi.mock("./reply-elevated.js", () => ({
  formatElevatedUnavailableMessage: mocks.formatElevatedUnavailableMessage,
  resolveElevatedPermissions: mocks.resolveElevatedPermissions,
}));
vi.mock("./reply-inline.js", () => ({
  stripInlineStatus: mocks.stripInlineStatus,
}));

const { resolveReplyDirectives } = await import("./get-reply-directives.js");
type ResolveReplyDirectivesParams = Parameters<typeof resolveReplyDirectives>[0];

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:7878536106",
    ChatType: "direct",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:direct:7878536106",
    From: "telegram:user:42",
    To: "telegram:7878536106",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

function buildSessionCtx(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    Body: "hello",
    BodyForAgent: "hello",
    BodyStripped: "hello",
    BodyForCommands: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    ...overrides,
  } as TemplateContext;
}

function buildSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1710000000000,
    ...overrides,
  };
}

function buildParams(
  sessionEntryOverrides: Partial<SessionEntry> = {},
  reasoningDefault?: "on" | "stream",
): ResolveReplyDirectivesParams {
  return {
    ctx: buildCtx(),
    cfg: {
      agents: {
        defaults: {
          reasoningDefault,
        },
      },
    },
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: {
      reasoningDefault,
    },
    sessionCtx: buildSessionCtx(),
    sessionEntry: buildSessionEntry(sessionEntryOverrides),
    sessionStore: {},
    sessionKey: "agent:main:telegram:direct:7878536106",
    storePath: "/tmp/sessions.json",
    sessionScope: "per-sender" satisfies SessionScope,
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: "hello",
    commandAuthorized: true,
    defaultProvider: "sub2api",
    defaultModel: "gpt-5.4",
    aliasIndex: new Map(),
    provider: "sub2api",
    model: "gpt-5.4",
    hasResolvedHeartbeatModelOverride: false,
    typing: {
      cleanup: vi.fn(),
    },
  };
}

describe("resolveReplyDirectives reasoning default fallback", () => {
  beforeEach(() => {
    mocks.resolveFastModeState.mockClear();
    mocks.resolveSandboxRuntimeStatus.mockClear();
    mocks.listChatCommands.mockClear();
    mocks.shouldHandleTextCommands.mockClear();
    mocks.listSkillCommandsForWorkspace.mockClear();
    mocks.resolveBlockStreamingChunking.mockClear();
    mocks.buildCommandContext.mockClear();
    mocks.parseInlineDirectives.mockClear();
    mocks.applyInlineDirectiveOverrides.mockClear();
    mocks.defaultGroupActivation.mockClear();
    mocks.resolveGroupRequireMention.mockClear();
    mocks.stripMentions.mockClear();
    mocks.stripStructuralPrefixes.mockClear();
    mocks.createModelSelectionState.mockClear();
    mocks.resolveContextTokens.mockClear();
    mocks.formatElevatedUnavailableMessage.mockClear();
    mocks.resolveElevatedPermissions.mockClear();
    mocks.stripInlineStatus.mockClear();
  });

  it("falls back to agent reasoningDefault when session override is absent", async () => {
    const result = await resolveReplyDirectives(buildParams({}, "on"));

    expect(result.kind).toBe("continue");
    expect(result.kind === "continue" ? result.result.resolvedReasoningLevel : undefined).toBe(
      "on",
    );
  });

  it("keeps session reasoning override ahead of agent reasoningDefault", async () => {
    const result = await resolveReplyDirectives(buildParams({ reasoningLevel: "stream" }, "on"));

    expect(result.kind).toBe("continue");
    expect(result.kind === "continue" ? result.result.resolvedReasoningLevel : undefined).toBe(
      "stream",
    );
  });
});
