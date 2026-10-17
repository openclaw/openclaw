/** Tests directive handling for target-session command turns. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import {
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { FinalizedTemplateContext as TemplateContext } from "../templating.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  expectContinueResult,
  makeSessionEntry,
  makeTypingController,
  mockCallInput,
} from "./get-reply-directives.target-session.test-helpers.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

const mocks = vi.hoisted(() => ({
  createModelSelectionState: vi.fn(),
  applyInlineDirectiveOverrides: vi.fn(),
  listAgentEntries: vi.fn(),
  resolveFastModeState: vi.fn(),
  resolveReplyExecOverrides: vi.fn(),
  resolveGroupRequireMention: vi.fn(async (_params: unknown) => false),
  shouldHandleTextCommands: vi.fn(() => false),
}));

async function resolveHelloWithModelDefaults(params: {
  body?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  agentCfg?: { reasoningDefault?: "off" | "on" | "stream" };
  commandAuthorized?: boolean;
  ctx?: Parameters<typeof buildTestCtx>[0];
  sessionCtx?: Partial<TemplateContext>;
  opts?: Parameters<typeof resolveReplyDirectives>[0]["opts"];
  modelError?: unknown;
}) {
  const resolveDefaultThinkingLevel = vi.fn(async () => "off");
  const resolveDefaultReasoningLevel = vi.fn(async () => "on");
  if (params.modelError) {
    mocks.createModelSelectionState.mockRejectedValueOnce(params.modelError);
  } else {
    mocks.createModelSelectionState.mockResolvedValueOnce({
      provider: "openai",
      model: "gpt-4o-mini",
      allowedModelKeys: new Set<string>(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      resolveDefaultThinkingLevel,
      resolveDefaultReasoningLevel,
    });
  }
  const typing = makeTypingController();
  const body = params.body ?? "hello";
  const sessionCtx = {
    Body: body,
    BodyStripped: body,
    BodyForAgent: body,
    CommandBody: body,
    commandText: body,
    agentText: body,
    rawText: body,
    Provider: "whatsapp",
    ...params.sessionCtx,
  } as TemplateContext;

  const sessionEntry = params.sessionEntry ?? makeSessionEntry();

  const result = await resolveReplyDirectives({
    ctx: buildTestCtx({
      Body: body,
      CommandBody: body,
      ...params.ctx,
    }),
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/main-agent",
    workspaceDir: "/tmp",
    agentCfg: params.agentCfg ?? {},
    sessionCtx,
    sessionEntry,
    sessionStore: params.sessionStore ?? {},
    sessionKey: "agent:main:whatsapp:+2000",
    storePath: "/tmp/sessions.json",
    sessionScope: "per-sender",
    conversation: prepareReplyConversation({
      ctx: sessionCtx,
      sessionEntry: params.sessionStore?.["agent:main:whatsapp:+2000"] ?? sessionEntry,
      isHeartbeat: params.opts?.isHeartbeat,
    }),
    isGroup: false,
    triggerBodyNormalized: "hello",
    resetTriggered: false,
    commandAuthorized: params.commandAuthorized ?? false,
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "openai",
    model: "gpt-4o-mini",
    hasResolvedHeartbeatModelOverride: false,
    typing,
    opts: params.opts,
  });

  return { result, resolveDefaultThinkingLevel, resolveDefaultReasoningLevel, typing };
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
  }: {
    cfg: Parameters<typeof resolveReplyDirectives>[0]["cfg"];
    provider: string;
    modelId: string;
  }) =>
    cfg.agents?.defaults?.models?.[`${provider}/${modelId}`]?.agentRuntime?.id ??
    (provider === "openai" ? "codex" : "openclaw"),
}));

vi.mock("../commands-text-routing.js", () => ({
  shouldHandleTextCommands: () => mocks.shouldHandleTextCommands(),
}));

vi.mock("./commands-context.js", () => ({
  buildCommandContext: vi.fn((params: { commandAuthorized?: boolean }) => ({
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    ownerList: [],
    senderIsOwner: false,
    isAuthorizedSender: params.commandAuthorized === true,
    senderId: undefined,
    abortKey: "abort-key",
    rawBodyNormalized: "hello",
    commandBodyNormalized: "hello",
    from: "whatsapp:+1000",
    to: "whatsapp:+2000",
  })),
}));

vi.mock("./directive-handling.parse.js", async () => {
  const { parseInlineDirectivesForTargetSessionTest } =
    await import("./get-reply-directives.target-session.test-helpers.js");
  return {
    parseInlineSessionDirectives: vi.fn(parseInlineDirectivesForTargetSessionTest),
    resolveReplyDirectiveCommand: vi.fn(() => undefined),
  };
});

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
  resolveGroupRequireMention: (params: unknown) => mocks.resolveGroupRequireMention(params),
}));

// mock-isolation: Directive routing uses prepared model state, not live catalog/auth discovery.
vi.mock("./model-selection.js", () => ({
  createModelSelectionState: (...args: unknown[]) => mocks.createModelSelectionState(...args),
}));

vi.mock("./reply-elevated.js", () => ({
  formatElevatedUnavailableMessage: vi.fn(() => "elevated unavailable"),
  resolveElevatedPermissions: vi.fn(() => ({
    enabled: true,
    allowed: true,
    failures: [],
  })),
}));

describe("resolveReplyDirectives", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveGroupRequireMention.mockResolvedValue(false);
    mocks.shouldHandleTextCommands.mockReturnValue(false);
    mocks.listAgentEntries.mockReturnValue([]);
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
  });

  it("passes persisted session identity into system-event group activation resolution", async () => {
    const wrapperSessionEntry = makeSessionEntry({ sessionId: "wrapper-session" });
    const targetSessionEntry = makeSessionEntry({
      sessionId: "target-session",
      chatType: "channel",
      groupId: "C123",
      delivery: normalizeSessionDeliveryState({ context: { channel: "slack", to: "C123" } }),
    });

    await resolveHelloWithModelDefaults({
      sessionEntry: wrapperSessionEntry,
      sessionStore: { "agent:main:whatsapp:+2000": targetSessionEntry },
      ctx: { InternalTurnSource: "heartbeat" },
      sessionCtx: { InternalTurnSource: "heartbeat", Provider: undefined },
    });

    expect(mockCallInput(mocks.resolveGroupRequireMention).group).toMatchObject({
      channel: "slack",
      groupId: "C123",
    });
  });

  it.each([
    {
      name: "retry when model preparation sees a rotated session",
      error: new SessionWorkStartInvalidatedError(
        'Session "agent:main:whatsapp:+2000" changed while starting work. Retry.',
      ),
      text: 'Session "agent:main:whatsapp:+2000" changed while starting work. Retry.',
    },
    {
      name: "rejection when locked model preparation cannot preserve its model",
      error: new ModelSelectionLockedError(),
      text: MODEL_SELECTION_LOCKED_MESSAGE,
    },
  ])("returns a terminal $name", async ({ error, text }) => {
    const { result, typing } = await resolveHelloWithModelDefaults({ modelError: error });
    expect(result).toEqual({
      kind: "reply",
      reply: { text, isError: true },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(mocks.applyInlineDirectiveOverrides).not.toHaveBeenCalled();
  });

  it("preserves combined directive rejection delivery and its invocation rejection fact", async () => {
    const reply = { text: 'Model "openai/REJECTED_PRIVATE_TOKEN" is not allowed.', isError: true };
    const runState: ReplyOperationRunState = {};
    const opts: InternalGetReplyOptions = { [REPLY_OPERATION_RUN_STATE]: runState };
    mocks.applyInlineDirectiveOverrides.mockResolvedValueOnce({
      kind: "reply",
      reply: { ...reply },
      preRunRejection: "session-directive-rejected",
    });

    const { result } = await resolveHelloWithModelDefaults({
      body: "/model openai/REJECTED_PRIVATE_TOKEN\n/think high",
      commandAuthorized: true,
      opts,
    });

    expect(result).toEqual({ kind: "reply", reply });
    expect(runState.preRunRejection).toBe("session-directive-rejected");
    if (result.kind !== "reply" || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected a single directive reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("preserves explicitly suppressed command-shaped text for the model", async () => {
    const body = "/model openai/gpt-5.5";
    mocks.shouldHandleTextCommands.mockReturnValue(true);

    const { result } = await resolveHelloWithModelDefaults({
      body,
      commandAuthorized: true,
      ctx: {
        CommandInterpretationSuppressed: true,
        CommandTurn: {
          kind: "normal",
          source: "message",
          authorized: false,
          body,
        },
      },
    });

    await expectContinueResult(result, { cleanedBody: body });
    expect(mockCallInput(mocks.createModelSelectionState).hasModelDirective).toBe(false);
    expect(mockCallInput(mocks.applyInlineDirectiveOverrides).directives).toMatchObject({
      hasModelDirective: false,
    });
  });

  it.each([
    {
      name: "ignores inline reasoning directives from untrusted senders",
      params: { body: "/reasoning stream" },
      expected: "off",
    },
    {
      name: "does not expose session reasoning state to untrusted senders",
      params: { sessionEntry: makeSessionEntry({ reasoningLevel: "stream" }) },
      expected: "off",
    },
    {
      name: "allows session reasoning state for authorized senders",
      params: {
        sessionEntry: makeSessionEntry({ reasoningLevel: "stream" }),
        commandAuthorized: true,
      },
      expected: "stream",
    },
    {
      name: "allows configured reasoning defaults for operator gateway clients",
      params: {
        agentCfg: { reasoningDefault: "stream" },
        ctx: { GatewayClientScopes: ["operator.admin"] },
      },
      expected: "stream",
    },
  ] satisfies Array<{
    name: string;
    params: Parameters<typeof resolveHelloWithModelDefaults>[0];
    expected: string;
  }>)("$name", async ({ params, expected }) => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults(params);
    await expectContinueResult(result, { resolvedReasoningLevel: expected });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });
});
