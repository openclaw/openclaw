/** Tests directive handling for target-session command turns. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import {
  cleanupTargetSessionDirectiveMocks,
  expectContinueResult,
  getTargetSessionDirectiveMocks,
  makeSessionEntry,
  makeTypingController,
  mockCallInput,
  resetTargetSessionDirectiveMocks,
  resolveHelloWithModelDefaults,
  resolveReplyDirectives,
} from "./get-reply-directives.target-session.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const mocks = getTargetSessionDirectiveMocks();

describe("resolveReplyDirectives", () => {
  beforeEach(resetTargetSessionDirectiveMocks);
  afterEach(cleanupTargetSessionDirectiveMocks);

  it("passes one-turn model override state into model selection", async () => {
    await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      provider: "openai",
      model: "gpt-4o-mini",
      hasOneTurnModelOverride: true,
    });

    const modelSelectionInput = mockCallInput(mocks.createModelSelectionState);
    expect(modelSelectionInput.provider).toBe("openai");
    expect(modelSelectionInput.model).toBe("gpt-4o-mini");
    expect(modelSelectionInput.hasOneTurnModelOverride).toBe(true);
  });

  it("returns a terminal retry when model preparation sees a rotated session", async () => {
    const error = new SessionWorkStartInvalidatedError(
      'Session "agent:main:whatsapp:+2000" changed while starting work. Retry.',
    );
    const { result, typing } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      modelError: error,
    });

    expect(result).toEqual({ kind: "reply", reply: { text: error.message } });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(mocks.applyInlineDirectiveOverrides).not.toHaveBeenCalled();
  });

  it("returns a terminal rejection when locked model preparation cannot preserve its model", async () => {
    const { result, typing } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      modelError: new ModelSelectionLockedError(),
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(mocks.applyInlineDirectiveOverrides).not.toHaveBeenCalled();
  });

  it("does not apply directive session mutations when policy denies the final command", async () => {
    const sessionEntry = makeSessionEntry({
      modelOverride: "gpt-4o-mini",
      providerOverride: "openai",
    });
    const before = structuredClone(sessionEntry);
    const policy = vi.fn((request: { commandName: string }, context: { sessionId?: string }) =>
      request.commandName === "model" && context.sessionId === sessionEntry.sessionId
        ? ({ effect: "deny", code: "model-denied" } as const)
        : ({ effect: "pass" } as const),
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect session directives",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);

    const { result, typing } = await resolveHelloWithModelDefaults({
      body: "/model openai/gpt-5.5",
      commandAuthorized: true,
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry,
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: "Command blocked by authorization policy." },
    });
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "model",
        owner: { kind: "core" },
        arguments: {
          raw: "openai/gpt-5.5",
          values: { provider: "openai", model: "gpt-5.5", runtime: "codex" },
        },
      }),
      expect.objectContaining({ sessionId: sessionEntry.sessionId }),
      expect.any(AbortSignal),
    );
    expect(policy).toHaveBeenCalledTimes(1);
    expect(mocks.applyInlineDirectiveOverrides).not.toHaveBeenCalled();
    expect(sessionEntry).toEqual(before);
    expect(typing.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["/model openai/gpt-5.5", "model"],
    ["/reasoning stream", "reasoning"],
  ])("authorizes %s against the target session", async (body, commandName) => {
    const wrapperSessionEntry = makeSessionEntry({ sessionId: "wrapper-session" });
    const targetSessionEntry = makeSessionEntry({ sessionId: "target-session" });
    const policy = vi.fn((request: { commandName: string }, context: { sessionId?: string }) =>
      request.commandName === commandName && context.sessionId === targetSessionEntry.sessionId
        ? ({ effect: "deny", code: "target-session-denied" } as const)
        : ({ effect: "pass" } as const),
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "target-session-actions",
        description: "Protect the command target session",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);

    const { result } = await resolveHelloWithModelDefaults({
      body,
      commandAuthorized: true,
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry: wrapperSessionEntry,
      sessionStore: {
        "agent:main:whatsapp:+2000": targetSessionEntry,
      },
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: "Command blocked by authorization policy." },
    });
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({ commandName }),
      expect.objectContaining({
        sessionId: targetSessionEntry.sessionId,
        sessionKey: "agent:main:whatsapp:+2000",
      }),
      expect.any(AbortSignal),
    );
    expect(policy).toHaveBeenCalledTimes(1);
    expect(mocks.applyInlineDirectiveOverrides).not.toHaveBeenCalled();
  });

  it("authorizes a numeric model alias as its concrete selection before mutation", async () => {
    const sessionEntry = makeSessionEntry({
      modelOverride: "gpt-4o-mini",
      providerOverride: "openai",
    });
    const before = structuredClone(sessionEntry);
    const policy = vi.fn((request: { arguments?: { values?: Record<string, unknown> } }) => {
      const values = request.arguments?.values;
      return values?.provider === "anthropic" &&
        values.model === "claude-opus-4-6" &&
        values.runtime === "openclaw"
        ? ({ effect: "deny", code: "model-denied" } as const)
        : ({ effect: "pass" } as const);
    });
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect concrete model selections",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);

    const { result } = await resolveHelloWithModelDefaults({
      body: "/model 3",
      commandAuthorized: true,
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry,
      aliasIndex: {
        byAlias: new Map([
          [
            "3",
            {
              alias: "3",
              ref: { provider: "anthropic", model: "claude-opus-4-6" },
            },
          ],
        ]),
        byKey: new Map([["anthropic/claude-opus-4-6", ["3"]]]),
      },
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: "Command blocked by authorization policy." },
    });
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "model",
        arguments: {
          raw: "3",
          values: {
            provider: "anthropic",
            model: "claude-opus-4-6",
            runtime: "openclaw",
          },
        },
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(policy).toHaveBeenCalledTimes(1);
    expect(mocks.applyInlineDirectiveOverrides).not.toHaveBeenCalled();
    expect(sessionEntry).toEqual(before);
  });

  it("authorizes a runtime alias as its canonical runtime before mutation", async () => {
    const sessionEntry = makeSessionEntry({
      modelOverride: "gpt-4o-mini",
      providerOverride: "openai",
      agentRuntimeOverride: "openclaw",
    });
    const before = structuredClone(sessionEntry);
    const policy = vi.fn((request: { arguments?: { values?: Record<string, unknown> } }) =>
      request.arguments?.values?.runtime === "codex"
        ? ({ effect: "deny", code: "runtime-denied" } as const)
        : ({ effect: "pass" } as const),
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect concrete runtime selections",
        handlers: { "command.invoke": policy },
      },
    });
    setActivePluginRegistry(registry);

    const { result } = await resolveHelloWithModelDefaults({
      body: "/model openai/gpt-5.5 --runtime codex-app-server",
      commandAuthorized: true,
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry,
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: "Command blocked by authorization policy." },
    });
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "model",
        arguments: {
          raw: "openai/gpt-5.5 --runtime codex-app-server",
          values: {
            provider: "openai",
            model: "gpt-5.5",
            runtime: "codex",
          },
        },
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(policy).toHaveBeenCalledTimes(1);
    expect(mocks.applyInlineDirectiveOverrides).not.toHaveBeenCalled();
    expect(sessionEntry).toEqual(before);
  });

  it("marks terminal directive replies for delivery under source suppression", async () => {
    mocks.applyInlineDirectiveOverrides.mockResolvedValueOnce({
      kind: "reply",
      reply: { text: "Model set to fable (anthropic/claude-fable-5) for this session." },
    });

    const { result } = await resolveHelloWithModelDefaults({
      body: "/model fable",
      commandAuthorized: true,
      defaultThinking: "off",
      defaultReasoning: "on",
    });

    expect(result.kind).toBe("reply");
    if (result.kind !== "reply" || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected a single directive reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("keeps one-turn fast mode with the resolved fast mode", async () => {
    const { result } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      opts: {
        fastModeOverride: "auto",
      },
    });

    expectContinueResult(result, {
      resolvedFastMode: "auto",
      resolvedFastModeAutoOnSeconds: 60,
    });
  });

  it("resolves fast defaults after model selection updates provider and model", async () => {
    mocks.resolveFastModeState.mockImplementation(
      ({ provider, model }: { provider?: string; model?: string }) => ({
        mode: provider === "openai" && model === "gpt-5.5" ? "auto" : false,
        enabled: provider === "openai" && model === "gpt-5.5",
        source: "config",
        fastAutoOnSeconds: provider === "openai" && model === "gpt-5.5" ? 30 : 60,
      }),
    );

    const { result } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      provider: "anthropic",
      model: "claude-opus-4-6",
      selectedProvider: "openai",
      selectedModel: "gpt-5.5",
    });

    expect(mockCallInput(mocks.resolveFastModeState)).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
    });
    expectContinueResult(result, {
      provider: "openai",
      model: "gpt-5.5",
      resolvedFastMode: "auto",
      resolvedFastModeAutoOnSeconds: 30,
    });
  });

  it.each([
    ["gpt-5.6-terra", "medium"],
    ["gpt-5.6-luna", "medium"],
  ] as const)(
    "resolves the %s thinking default after a mixed model switch",
    async (targetModel, expectedThinking) => {
      mocks.applyInlineDirectiveOverrides.mockImplementationOnce(async (params) => ({
        kind: "continue",
        directives: params.directives,
        provider: "openai",
        model: targetModel,
        contextTokens: params.contextTokens,
      }));

      const { result, resolveDefaultThinkingLevel } = await resolveHelloWithModelDefaults({
        body: `reply to this\n/model openai/${targetModel}`,
        commandAuthorized: true,
        defaultThinking: "low",
        defaultThinkingByModel: {
          "gpt-5.6-sol": "low",
          [targetModel]: expectedThinking,
        },
        defaultReasoning: "on",
        selectedProvider: "openai",
        selectedModel: "gpt-5.6-sol",
        cfg: {
          agents: {
            defaults: {
              models: {
                [`openai/${targetModel}`]: { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
      });

      expectContinueResult(result, { resolvedThinkLevel: expectedThinking });
      expect(resolveDefaultThinkingLevel).toHaveBeenLastCalledWith({
        provider: "openai",
        model: targetModel,
        agentRuntime: "codex",
      });
    },
  );

  it("uses the Sol default on the switching turn from a non-reasoning model", async () => {
    mocks.applyInlineDirectiveOverrides.mockImplementationOnce(async (params) => ({
      kind: "continue",
      directives: params.directives,
      provider: "openai",
      model: "gpt-5.6-sol",
      contextTokens: params.contextTokens,
    }));

    const { result, resolveDefaultThinkingLevel } = await resolveHelloWithModelDefaults({
      body: "reply to this\n/model openai/gpt-5.6-sol",
      commandAuthorized: true,
      defaultThinking: "off",
      defaultThinkingByModel: { "gpt-5.6-sol": "low" },
      defaultReasoning: "on",
      selectedProvider: "openai",
      selectedModel: "gpt-4o-mini",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    });

    expectContinueResult(result, { resolvedThinkLevel: "low" });
    expect(resolveDefaultThinkingLevel).toHaveBeenLastCalledWith({
      provider: "openai",
      model: "gpt-5.6-sol",
      agentRuntime: "openclaw",
    });
  });

  it("prefers the target session entry from sessionStore for directive state", async () => {
    const wrapperSessionEntry = makeSessionEntry({
      sessionId: "wrapper-session",
      thinkingLevel: "low",
      verboseLevel: "off",
      reasoningLevel: "off",
      elevatedLevel: "off",
      parentSessionKey: "wrapper-parent",
    });
    const targetSessionEntry = makeSessionEntry({
      sessionId: "target-session",
      thinkingLevel: "high",
      verboseLevel: "full",
      reasoningLevel: "high",
      elevatedLevel: "on",
      parentSessionKey: "target-parent",
    });

    const result = await resolveReplyDirectives({
      ctx: buildTestCtx({
        Body: "hello",
        CommandBody: "hello",
        ParentSessionKey: "ctx-parent",
      }),
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp",
      agentCfg: {},
      sessionCtx: {
        Body: "hello",
        BodyStripped: "hello",
        BodyForAgent: "hello",
        CommandBody: "hello",
        Provider: "whatsapp",
      } as TemplateContext,
      sessionEntry: wrapperSessionEntry,
      sessionStore: {
        "agent:main:whatsapp:+2000": targetSessionEntry,
      },
      sessionKey: "agent:main:whatsapp:+2000",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "hello",
      resetTriggered: false,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-4o-mini",
      hasResolvedHeartbeatModelOverride: false,
      typing: {
        onReplyStart: async () => {},
        startTypingLoop: async () => {},
        startTypingOnText: async () => {},
        refreshTypingTtl: () => {},
        isActive: () => false,
        markRunComplete: () => {},
        markDispatchIdle: () => {},
        cleanup: vi.fn(),
      },
      opts: undefined,
      skillFilter: undefined,
    });

    expect(mockCallInput(mocks.resolveFastModeState).sessionEntry).toBe(targetSessionEntry);
    const modelSelectionInput = mockCallInput(mocks.createModelSelectionState);
    expect(modelSelectionInput.sessionEntry).toBe(targetSessionEntry);
    expect(modelSelectionInput.parentSessionKey).toBe("target-parent");
    expect(mockCallInput(mocks.applyInlineDirectiveOverrides).sessionEntry).toBe(
      targetSessionEntry,
    );
    expect(mockCallInput(mocks.resolveReplyExecOverrides).sessionEntry).toBe(targetSessionEntry);
    expectContinueResult(result, {
      resolvedThinkLevel: "high",
      resolvedFastMode: true,
      resolvedVerboseLevel: "full",
      resolvedReasoningLevel: "high",
      resolvedElevatedLevel: "on",
    });
  });

  it("returns a directive-only ack for trace commands instead of continuing into the agent path", async () => {
    mocks.applyInlineDirectiveOverrides.mockResolvedValueOnce({
      kind: "reply",
      reply: {
        text: "⚙️ Trace enabled. Warning: trace output may contain sensitive information.",
      },
    });

    const result = await resolveReplyDirectives({
      ctx: buildTestCtx({
        Body: "/trace on",
        CommandBody: "/trace on",
        CommandAuthorized: true,
      }),
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp",
      agentCfg: {},
      sessionCtx: {
        Body: "/trace on",
        BodyStripped: "/trace on",
        BodyForAgent: "/trace on",
        CommandBody: "/trace on",
        Provider: "telegram",
        Surface: "telegram",
      } as TemplateContext,
      sessionEntry: makeSessionEntry(),
      sessionStore: {
        "agent:main:telegram:+2000": makeSessionEntry(),
      },
      sessionKey: "agent:main:telegram:+2000",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "/trace on",
      resetTriggered: false,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-4o-mini",
      hasResolvedHeartbeatModelOverride: false,
      typing: makeTypingController(),
      opts: undefined,
      skillFilter: undefined,
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "⚙️ Trace enabled. Warning: trace output may contain sensitive information.",
      },
    });
  });

  it("uses the model reasoning default when thinking is off", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "on",
    });
    expect(resolveDefaultReasoningLevel).toHaveBeenCalledOnce();
  });

  it("does not re-enable model reasoning when thinking was explicitly disabled", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry: makeSessionEntry({ thinkingLevel: "off" }),
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not re-enable model reasoning when thinking override explicitly disables thinking", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      opts: { thinkingLevelOverride: "off" },
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not re-enable model reasoning when per-agent thinking default disables thinking", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentEntries: [{ id: "main", thinkingDefault: "off" }],
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not re-enable model reasoning when per-model thinking config disables thinking", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      hasConfiguredThinkingDefault: true,
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("skips the model reasoning default when thinking is active", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "low",
      defaultReasoning: "on",
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "low",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not re-enable model reasoning when agentCfg reasoningDefault is explicitly off", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentCfg: { reasoningDefault: "off" },
    });

    expectContinueResult(result, {
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not expose configured reasoning defaults to untrusted senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentCfg: { reasoningDefault: "stream" },
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("ignores inline reasoning directives from untrusted senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      body: "/reasoning stream",
      defaultThinking: "off",
      defaultReasoning: "on",
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("does not expose session reasoning state to untrusted senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry: makeSessionEntry({ reasoningLevel: "stream" }),
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "off",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("allows session reasoning state for authorized senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      sessionEntry: makeSessionEntry({ reasoningLevel: "stream" }),
      commandAuthorized: true,
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "stream",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("allows configured reasoning defaults for operator gateway clients", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentCfg: { reasoningDefault: "stream" },
      ctx: { GatewayClientScopes: ["operator.admin"] },
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "stream",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("allows configured reasoning defaults for authorized senders", async () => {
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults({
      defaultThinking: "off",
      defaultReasoning: "on",
      agentCfg: { reasoningDefault: "stream" },
      commandAuthorized: true,
    });

    expectContinueResult(result, {
      resolvedReasoningLevel: "stream",
    });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it("keeps consumed text reset triggers empty after directive cleanup", async () => {
    const sessionCtx = {
      Body: "",
      BodyStripped: "",
      BodyForAgent: "",
      BodyForCommands: "new session",
      CommandBody: "new session",
      Provider: "slack",
      Surface: "slack",
    } as TemplateContext;

    const result = await resolveReplyDirectives({
      ctx: buildTestCtx({
        Body: "new session",
        BodyForAgent: "new session",
        BodyForCommands: "new session",
        CommandBody: "new session",
        CommandAuthorized: true,
        Provider: "slack",
        Surface: "slack",
      }),
      cfg: {
        session: {
          resetTriggers: ["/new", "/reset", "new session"],
        },
      },
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp",
      agentCfg: {},
      sessionCtx,
      sessionEntry: makeSessionEntry(),
      sessionStore: {
        "agent:main:slack:C123": makeSessionEntry(),
      },
      sessionKey: "agent:main:slack:C123",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "new session",
      resetTriggered: true,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-4o-mini",
      hasResolvedHeartbeatModelOverride: false,
      typing: makeTypingController(),
      opts: undefined,
      skillFilter: undefined,
    });

    expectContinueResult(result, {
      cleanedBody: "",
    });
    expect(sessionCtx.Body).toBe("");
    expect(sessionCtx.BodyForAgent).toBe("");
    expect(sessionCtx.BodyStripped).toBe("");
  });
});
