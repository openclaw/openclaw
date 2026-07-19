/** Shared harness for reply-directive target-session tests. */
import { expect, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { TemplateContext } from "../templating.js";
import { resolveReplyDirectives as resolveReplyDirectivesImpl } from "./get-reply-directives.js";
import { buildTestCtx } from "./test-ctx.js";

export function resolveReplyDirectives(params: Parameters<typeof resolveReplyDirectivesImpl>[0]) {
  return resolveReplyDirectivesImpl(params);
}

const mocks = vi.hoisted(() => ({
  createModelSelectionState: vi.fn(),
  applyInlineDirectiveOverrides: vi.fn(),
  listAgentEntries: vi.fn(),
  resolveFastModeState: vi.fn(),
  resolveReplyExecOverrides: vi.fn(),
}));

export function getTargetSessionDirectiveMocks() {
  return mocks;
}

export function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function makeTypingController() {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

function parseInlineDirectivesForTest(body: string) {
  const normalized = body.trim();
  const modelMatch = normalized.match(/(?:^|\n)\/model\s+(\S+)(?:\s+--runtime\s+(\S+))?/);
  const modelDirective = modelMatch?.[1];
  if (modelDirective) {
    return {
      cleaned: normalized.replace(/(?:^|\n)\/model\s+\S+(?:\s+--runtime\s+\S+)?/, "").trim(),
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasTraceDirective: false,
      traceLevel: undefined,
      rawTraceLevel: undefined,
      hasFastDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasModelDirective: true,
      hasQueueDirective: false,
      hasStatusDirective: false,
      queueReset: false,
      thinkLevel: undefined,
      verboseLevel: undefined,
      fastMode: undefined,
      reasoningLevel: undefined,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
      rawModelDirective: modelDirective,
      rawModelRuntime: modelMatch?.[2],
      execSecurity: undefined,
    };
  }
  if (normalized === "/reasoning stream") {
    return {
      cleaned: "",
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasTraceDirective: false,
      traceLevel: undefined,
      rawTraceLevel: undefined,
      hasFastDirective: false,
      hasReasoningDirective: true,
      reasoningLevel: "stream",
      rawReasoningLevel: "stream",
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasModelDirective: false,
      hasQueueDirective: false,
      hasStatusDirective: false,
      queueReset: false,
      thinkLevel: undefined,
      verboseLevel: undefined,
      fastMode: undefined,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
      rawModelDirective: undefined,
      execSecurity: undefined,
    };
  }
  if (normalized === "/trace on") {
    return {
      cleaned: "",
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasTraceDirective: true,
      traceLevel: "on",
      rawTraceLevel: "on",
      hasFastDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
      hasExecDirective: false,
      hasModelDirective: false,
      hasQueueDirective: false,
      hasStatusDirective: false,
      queueReset: false,
      thinkLevel: undefined,
      verboseLevel: undefined,
      fastMode: undefined,
      reasoningLevel: undefined,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
      rawModelDirective: undefined,
      execSecurity: undefined,
    };
  }
  return {
    cleaned: body,
    hasThinkDirective: false,
    hasVerboseDirective: false,
    hasTraceDirective: false,
    traceLevel: undefined,
    rawTraceLevel: undefined,
    hasFastDirective: false,
    hasReasoningDirective: false,
    hasElevatedDirective: false,
    hasExecDirective: false,
    hasModelDirective: false,
    hasQueueDirective: false,
    hasStatusDirective: false,
    queueReset: false,
    thinkLevel: undefined,
    verboseLevel: undefined,
    fastMode: undefined,
    reasoningLevel: undefined,
    elevatedLevel: undefined,
    rawElevatedLevel: undefined,
    rawModelDirective: undefined,
    execSecurity: undefined,
  };
}

export function mockCallInput(
  mock: { mock: { calls: unknown[][] } },
  index = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  const input = call[0];
  if (!input || typeof input !== "object") {
    throw new Error(`expected mock input ${index}`);
  }
  return input as Record<string, unknown>;
}

export function expectContinueResult(
  value: Awaited<ReturnType<typeof resolveReplyDirectives>>,
  fields: Record<string, unknown>,
) {
  expect(value.kind).toBe("continue");
  if (value.kind !== "continue") {
    throw new Error(`expected continue result, got ${value.kind}`);
  }
  for (const [key, expected] of Object.entries(fields)) {
    expect(value.result[key as keyof typeof value.result]).toEqual(expected);
  }
}

export async function resolveHelloWithModelDefaults(params: {
  defaultThinking: "off" | "low" | "medium";
  defaultThinkingByModel?: Record<string, "off" | "low" | "medium">;
  defaultReasoning: "on";
  cfg?: Parameters<typeof resolveReplyDirectives>[0]["cfg"];
  body?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  agentCfg?: { reasoningDefault?: "off" | "on" | "stream" };
  agentEntries?: Array<{ id?: string; thinkingDefault?: "off" | "low" }>;
  hasConfiguredThinkingDefault?: boolean;
  commandAuthorized?: boolean;
  hasOneTurnModelOverride?: boolean;
  selectedProvider?: string;
  selectedModel?: string;
  provider?: string;
  model?: string;
  aliasIndex?: Parameters<typeof resolveReplyDirectives>[0]["aliasIndex"];
  ctx?: Parameters<typeof buildTestCtx>[0];
  opts?: Parameters<typeof resolveReplyDirectives>[0]["opts"];
  modelError?: unknown;
}) {
  const resolveDefaultThinkingLevel = vi.fn(
    async (selection?: { model?: string }) =>
      (selection?.model ? params.defaultThinkingByModel?.[selection.model] : undefined) ??
      params.defaultThinking,
  );
  const resolveDefaultReasoningLevel = vi.fn(async () => params.defaultReasoning);
  mocks.listAgentEntries.mockReturnValue(params.agentEntries ?? []);
  if (params.modelError) {
    mocks.createModelSelectionState.mockRejectedValueOnce(params.modelError);
  } else {
    mocks.createModelSelectionState.mockResolvedValueOnce({
      provider: params.selectedProvider ?? "openai",
      model: params.selectedModel ?? "gpt-4o-mini",
      allowedModelKeys: new Set<string>(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      resolveDefaultThinkingLevel,
      hasConfiguredThinkingDefault: params.hasConfiguredThinkingDefault,
      resolveDefaultReasoningLevel,
    });
  }
  const typing = makeTypingController();
  const body = params.body ?? "hello";
  const result = await resolveReplyDirectives({
    ctx: buildTestCtx({ Body: body, CommandBody: body, ...params.ctx }),
    cfg: params.cfg ?? {},
    agentId: "main",
    agentDir: "/tmp/main-agent",
    workspaceDir: "/tmp",
    agentCfg: params.agentCfg ?? {},
    sessionCtx: {
      Body: body,
      BodyStripped: body,
      BodyForAgent: body,
      CommandBody: body,
      Provider: "whatsapp",
    } as TemplateContext,
    sessionEntry: params.sessionEntry ?? makeSessionEntry(),
    sessionStore: params.sessionStore ?? {},
    sessionKey: "agent:main:whatsapp:+2000",
    storePath: "/tmp/sessions.json",
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: "hello",
    resetTriggered: false,
    commandAuthorized: params.commandAuthorized ?? false,
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: params.aliasIndex ?? { byAlias: new Map(), byKey: new Map() },
    provider: params.provider ?? "openai",
    model: params.model ?? "gpt-4o-mini",
    hasOneTurnModelOverride: params.hasOneTurnModelOverride,
    hasResolvedHeartbeatModelOverride: false,
    typing,
    opts: params.opts,
    skillFilter: undefined,
  });

  return { result, resolveDefaultThinkingLevel, resolveDefaultReasoningLevel, typing };
}

export function resetTargetSessionDirectiveMocks(): void {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  mocks.createModelSelectionState.mockReset();
  mocks.applyInlineDirectiveOverrides.mockReset();
  mocks.listAgentEntries.mockReset();
  mocks.resolveFastModeState.mockReset();
  mocks.resolveReplyExecOverrides.mockReset();
  mocks.listAgentEntries.mockReturnValue([]);
  mocks.createModelSelectionState.mockResolvedValue({
    provider: "openai",
    model: "gpt-4o-mini",
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    resolveThinkingCatalog: vi.fn(async () => []),
    resolveDefaultThinkingLevel: vi.fn(async () => "off"),
    resolveDefaultReasoningLevel: vi.fn(async () => "off"),
  });
  mocks.applyInlineDirectiveOverrides.mockImplementation(async (params) => ({
    kind: "continue",
    directives: params.directives,
    provider: params.provider,
    model: params.model,
    contextTokens: params.contextTokens,
  }));
  mocks.resolveFastModeState.mockImplementation(({ sessionEntry }) => ({
    mode: sessionEntry?.sessionId === "target-session",
    enabled: sessionEntry?.sessionId === "target-session",
    source: "session",
    fastAutoOnSeconds: 60,
  }));
  mocks.resolveReplyExecOverrides.mockReturnValue(undefined);
}

export function cleanupTargetSessionDirectiveMocks(): void {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
}

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: (...args: unknown[]) => mocks.listAgentEntries(...args),
}));

vi.mock("../../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 8192,
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: (...args: unknown[]) => mocks.resolveFastModeState(...args),
}));

vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../agents/thinking-runtime.js", () => ({
  resolveEffectiveAgentRuntime: ({
    cfg,
    provider,
    modelId,
    sessionEntry,
  }: {
    cfg: Parameters<typeof resolveReplyDirectives>[0]["cfg"];
    provider: string;
    modelId: string;
    sessionEntry?: SessionEntry;
  }) =>
    sessionEntry?.agentRuntimeOverride ??
    cfg.agents?.defaults?.models?.[`${provider}/${modelId}`]?.agentRuntime?.id ??
    (provider === "openai" ? "codex" : "openclaw"),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (value: string) => value,
}));

vi.mock("../commands-text-routing.js", () => ({
  shouldHandleTextCommands: vi.fn(() => false),
}));

vi.mock("./commands-context.js", () => ({
  buildCommandContext: vi.fn(
    (params: { commandAuthorized?: boolean; ctx?: { CommandBody?: string; Body?: string } }) => {
      const commandBodyNormalized = params.ctx?.CommandBody ?? params.ctx?.Body ?? "hello";
      return {
        surface: "whatsapp",
        channel: "whatsapp",
        channelId: "whatsapp",
        ownerList: [],
        senderIsOwner: false,
        isAuthorizedSender: params.commandAuthorized === true,
        senderId: undefined,
        abortKey: "abort-key",
        rawBodyNormalized: commandBodyNormalized,
        commandBodyNormalized,
        from: "whatsapp:+1000",
        to: "whatsapp:+2000",
      };
    },
  ),
}));

vi.mock("./directive-handling.parse.js", () => ({
  parseInlineDirectives: vi.fn(parseInlineDirectivesForTest),
}));

vi.mock("./get-reply-directive-aliases.js", () => ({
  reserveSkillCommandNames: vi.fn(),
  resolveConfiguredDirectiveAliases: vi.fn(() => []),
}));

vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: (...args: unknown[]) =>
    mocks.applyInlineDirectiveOverrides(...args),
}));

vi.mock("./runtime-policy-session-key.js", () => ({
  resolveRuntimePolicySessionKey: ({ sessionKey }: { sessionKey?: string }) => sessionKey,
}));

vi.mock("./get-reply-exec-overrides.js", () => ({
  resolveReplyExecOverrides: (...args: unknown[]) => mocks.resolveReplyExecOverrides(...args),
}));

vi.mock("./get-reply-fast-path.js", () => ({
  shouldUseReplyFastTestRuntime: vi.fn(() => false),
}));

vi.mock("./groups.js", () => ({
  defaultGroupActivation: vi.fn(() => "always"),
  resolveGroupRequireMention: vi.fn(async () => false),
}));

vi.mock("./model-selection.js", () => ({
  createFastTestModelSelectionState: vi.fn(),
  createModelSelectionState: (...args: unknown[]) => mocks.createModelSelectionState(...args),
  resolveContextTokens: vi.fn(() => 4096),
}));

vi.mock("./reply-elevated.js", () => ({
  formatElevatedUnavailableMessage: vi.fn(() => "elevated unavailable"),
  resolveElevatedPermissions: vi.fn(() => ({
    enabled: true,
    allowed: true,
    failures: [],
  })),
}));
