// Shared get-reply test fixtures for sessions, directives, and mocked runtimes.
import { expect, vi, type Mock } from "vitest";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedRuntimeMsgContext, MsgContext } from "../templating.js";
import type { ReasoningLevel, ThinkLevel } from "../thinking.js";
import { finalizeInboundContext } from "./inbound-context.js";
import type { ReplyModelSelection } from "./model-runtime-normalization.js";
import type { createModelSelectionState } from "./model-selection.js";

export function buildGetReplyCtx(overrides: Partial<MsgContext> = {}): FinalizedRuntimeMsgContext {
  return finalizeInboundContext({
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:123",
    From: "telegram:user:42",
    To: "telegram:123",
    Timestamp: 1710000000000,
    ...overrides,
  });
}

export function buildGetReplyGroupCtx(
  overrides: Partial<MsgContext> = {},
): FinalizedRuntimeMsgContext {
  return finalizeInboundContext({
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:-100123",
    ChatType: "group",
    Body: "hello world",
    BodyForAgent: "hello world",
    RawBody: "hello world",
    CommandBody: "hello world",
    BodyForCommands: "hello world",
    SessionKey: "agent:main:telegram:-100123",
    From: "telegram:user:42",
    To: "telegram:-100123",
    Timestamp: 1710000000000,
    ...overrides,
  });
}

export function buildNativeResetContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "/new",
    RawBody: "/new",
    CommandBody: "/new",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "telegram:slash:123",
    CommandTargetSessionKey: "agent:main:telegram:direct:123",
    From: "telegram:123",
    To: "slash:123",
  };
}

export function createGetReplySessionState(overrides: Record<string, unknown> = {}) {
  return {
    sessionCtx: {},
    sessionEntry: {},
    previousSessionEntry: {},
    sessionStore: {},
    sessionKey: "agent:main:telegram:123",
    sessionId: "session-1",
    isNewSession: false,
    resetTriggered: false,
    systemSent: false,
    abortedLastRun: false,
    storePath: "/tmp/sessions.json",
    sessionScope: "per-chat",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: "",
    bodyStripped: "",
    ...overrides,
  };
}

export function registerGetReplyBaselineBypass(): void {
  vi.doMock("../../sessions/session-diff-baseline.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../sessions/session-diff-baseline.js")>();
    return {
      ...actual,
      ensureSessionDiffBaseline: vi.fn(
        async (params: Parameters<typeof actual.ensureSessionDiffBaseline>[0]) => params.entry,
      ),
    };
  });
}

/** Builds an explicit prepared owner result for directive reducer tests. */
export function createModelSelectionStateFixture(params: {
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
}): Awaited<ReturnType<typeof createModelSelectionState>> {
  const selection: ReplyModelSelection = {
    ref: { provider: params.provider, model: params.model },
    normalization: "applied",
    routeResolution: "resolved",
  };
  return {
    defaultSelection: selection,
    primarySelection: selection,
    resolveAutoFallbackPrimaryProbe: () => undefined,
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: "resolved",
    modelPolicy: createModelVisibilityPolicy({
      cfg: { agents: { defaults: params.agentCfg } },
      catalog: [],
      defaultProvider: params.provider,
      defaultModel: { provider: params.provider, model: params.model },
    }),
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    policyAliasIndex: { byAlias: new Map(), byKey: new Map() },
    resetModelOverride: false,
    resetModelOverrideRef: undefined,
    resetModelOverrideReason: undefined,
    modelPolicyConfigPath: undefined,
    modelPolicyRepairConfigPath: undefined,
    resolveThinkingCatalog: async () => [],
    resolveDefaultThinkingLevel: async () => params.agentCfg?.thinkingDefault as ThinkLevel,
    hasConfiguredThinkingDefault: params.agentCfg?.thinkingDefault !== undefined,
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
    modelContextWindow: undefined,
    modelContextTokens: undefined,
  };
}

export function createGetReplyContinueDirectivesResult(params: {
  defaultRef: ModelRef;
  primaryRef?: ModelRef;
  modelState?: Awaited<ReturnType<typeof createModelSelectionState>>;
  body: string;
  abortKey: string;
  from: string;
  to: string;
  senderId: string;
  commandSource: string;
  senderIsOwner: boolean;
  resetHookTriggered: boolean;
  provider?: string;
  model?: string;
  resolvedThinkLevel?: ThinkLevel;
  resolvedReasoningLevel?: ReasoningLevel;
}) {
  const defaultSelection = {
    ref: params.defaultRef,
    normalization: "applied" as const,
    routeResolution: "resolved" as const,
  };
  return {
    kind: "continue" as const,
    result: {
      commandSource: params.commandSource,
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "telegram",
        ownerList: [],
        senderIsOwner: params.senderIsOwner,
        isAuthorizedSender: true,
        senderId: params.senderId,
        abortKey: params.abortKey,
        rawBodyNormalized: params.body,
        commandBodyNormalized: params.body,
        from: params.from,
        to: params.to,
        resetHookTriggered: params.resetHookTriggered,
      },
      allowTextCommands: true,
      skillCommands: [],
      directives: {},
      cleanedBody: params.body,
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: "always",
      resolvedThinkLevel: params.resolvedThinkLevel,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: params.resolvedReasoningLevel ?? "off",
      resolvedElevatedLevel: "off",
      execOverrides: undefined,
      blockStreamingEnabled: false,
      blockReplyChunking: undefined,
      resolvedBlockStreamingBreak: undefined,
      provider: params.provider ?? "openai",
      model: params.model ?? "gpt-4o-mini",
      requestedRouteResolution: params.modelState?.requestedRouteResolution ?? "resolved",
      modelState: params.modelState ?? {
        defaultSelection,
        primarySelection: params.primaryRef
          ? { ...defaultSelection, ref: params.primaryRef }
          : defaultSelection,
        resolveAutoFallbackPrimaryProbe: () => undefined,
        resolveDefaultThinkingLevel: async () => undefined,
        resolveThinkingCatalog: async () => [],
      },
      contextTokens: 0,
      inlineStatusRequested: false,
      directiveAck: undefined,
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
    },
  };
}

export function registerGetReplyRuntimeOverrides(handles: {
  resolveReplyDirectives: (...args: unknown[]) => unknown;
  initSessionState: (...args: unknown[]) => unknown;
  resolveReplySessionPreprocessingState?: (...args: unknown[]) => unknown;
  handleInlineActions?: (...args: unknown[]) => unknown;
}): void {
  vi.doMock("./get-reply-directives.js", () => ({
    resolveReplyDirectives: (...args: unknown[]) => handles.resolveReplyDirectives(...args),
  }));
  vi.doMock("./get-reply-inline-actions.js", () => ({
    handleInlineActions:
      handles.handleInlineActions ?? vi.fn(async () => ({ kind: "reply", reply: { text: "ok" } })),
  }));
  vi.doMock("./session.js", () => ({
    initSessionState: (...args: unknown[]) => handles.initSessionState(...args),
    resolveReplySessionPreprocessingState: (...args: unknown[]) =>
      handles.resolveReplySessionPreprocessingState?.(...args) ?? {
        sessionEntry: undefined,
        sessionKey: "agent:main:telegram:123",
        storePath: "/tmp/sessions.json",
      },
  }));
}

export function expectResolvedTelegramTimezone(
  resolveReplyDirectives: Mock,
  userTimezone = "America/New_York",
): void {
  expect(resolveReplyDirectives).toHaveBeenCalledTimes(1);
  const call = resolveReplyDirectives.mock.calls.at(0)?.[0] as
    | {
        cfg?: {
          channels?: { telegram?: { botToken?: unknown } };
          agents?: { defaults?: { userTimezone?: unknown } };
        };
      }
    | undefined;
  if (!call) {
    throw new Error("expected resolveReplyDirectives call");
  }
  expect(call.cfg?.channels?.telegram?.botToken).toBe("resolved-telegram-token");
  expect(call.cfg?.agents?.defaults?.userTimezone).toBe(userTimezone);
}
