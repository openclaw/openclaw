import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveEffectiveModelFallbacksMock = vi.fn();
  const resolveFallbackAgentIdMock = vi.fn();
  const resolveDefaultModelForAgentMock = vi.fn();
  return {
    resolveEffectiveModelFallbacksMock,
    resolveFallbackAgentIdMock,
    resolveDefaultModelForAgentMock,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveEffectiveModelFallbacks: (...args: unknown[]) =>
    hoisted.resolveEffectiveModelFallbacksMock(...args),
  resolveFallbackAgentId: (...args: unknown[]) => hoisted.resolveFallbackAgentIdMock(...args),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: (...args: unknown[]) =>
    hoisted.resolveDefaultModelForAgentMock(...args),
}));

const {
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunContexts,
  resolveModelFallbackOptions,
  resolveProviderScopedAuthProfile,
} = await import("./agent-runner-utils.js");

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config: { models: { providers: {} } },
    provider: "openai",
    model: "gpt-4.1",
    agentDir: "/tmp/agent",
    sessionKey: "agent:test:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: [],
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "none",
    execOverrides: {},
    bashElevated: false,
    timeoutMs: 60_000,
    ...overrides,
  } as unknown as FollowupRun["run"];
}

describe("agent-runner-utils", () => {
  beforeEach(() => {
    hoisted.resolveEffectiveModelFallbacksMock.mockClear();
    hoisted.resolveFallbackAgentIdMock.mockClear();
    hoisted.resolveDefaultModelForAgentMock.mockClear();
    // Default: configured primary matches run model (no session override).
    hoisted.resolveFallbackAgentIdMock.mockReturnValue("agent-1");
    hoisted.resolveDefaultModelForAgentMock.mockReturnValue({
      provider: "openai",
      model: "gpt-4.1",
    });
  });

  it("resolves model fallback options from run context", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["fallback-model"]);
    const run = makeRun();

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveFallbackAgentIdMock).toHaveBeenCalledWith({
      agentId: run.agentId,
      sessionKey: run.sessionKey,
    });
    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: "agent-1",
      hasSessionModelOverride: false,
    });
    expect(resolved).toEqual({
      cfg: run.config,
      provider: run.provider,
      model: run.model,
      agentDir: run.agentDir,
      fallbacksOverride: ["fallback-model"],
    });
  });

  it("passes through missing agentId for helper-based fallback resolution", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["fallback-model"]);
    hoisted.resolveFallbackAgentIdMock.mockReturnValue("default");
    const run = makeRun({ agentId: undefined });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveFallbackAgentIdMock).toHaveBeenCalledWith({
      agentId: undefined,
      sessionKey: run.sessionKey,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("detects session model override when provider differs from agent-aware primary", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["anthropic/claude-haiku-3-5"]);
    hoisted.resolveDefaultModelForAgentMock.mockReturnValue({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    const run = makeRun({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct:free",
    });

    resolveModelFallbackOptions(run);

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasSessionModelOverride: true }),
    );
  });

  it("detects session model override when model differs from agent-aware primary", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["anthropic/claude-haiku-3-5"]);
    hoisted.resolveDefaultModelForAgentMock.mockReturnValue({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    const run = makeRun({
      provider: "openai",
      model: "gpt-5.3-codex",
    });

    resolveModelFallbackOptions(run);

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasSessionModelOverride: true }),
    );
  });

  it("does not flag session model override when run matches agent-aware primary", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(undefined);
    hoisted.resolveDefaultModelForAgentMock.mockReturnValue({
      provider: "openai",
      model: "gpt-4.1",
    });
    const run = makeRun({
      provider: "openai",
      model: "gpt-4.1",
    });

    resolveModelFallbackOptions(run);

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasSessionModelOverride: false }),
    );
  });

  it("does not flag per-agent model.primary as a session override", () => {
    // Simulate an agent configured with its own model.primary (anthropic/claude-sonnet-4)
    // that differs from the global default (openai/gpt-4.1).
    // resolveDefaultModelForAgent returns the per-agent primary, so the run model
    // should match and hasSessionModelOverride should be false.
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(undefined);
    hoisted.resolveDefaultModelForAgentMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
    const run = makeRun({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });

    resolveModelFallbackOptions(run);

    expect(hoisted.resolveDefaultModelForAgentMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
    });
    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasSessionModelOverride: false }),
    );
  });

  it("returns undefined fallbacksOverride when cfg is falsy", () => {
    const run = makeRun({ config: undefined } as unknown as Partial<FollowupRun["run"]>);

    const resolved = resolveModelFallbackOptions(run);

    expect(resolved.fallbacksOverride).toBeUndefined();
    expect(hoisted.resolveEffectiveModelFallbacksMock).not.toHaveBeenCalled();
  });

  it("builds embedded run base params with auth profile and run metadata", () => {
    const run = makeRun({ enforceFinalTag: true });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "openai",
      primaryProvider: "openai",
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
    });

    const resolved = buildEmbeddedRunBaseParams({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      authProfile,
    });

    expect(resolved).toMatchObject({
      sessionFile: run.sessionFile,
      workspaceDir: run.workspaceDir,
      agentDir: run.agentDir,
      config: run.config,
      skillsSnapshot: run.skillsSnapshot,
      ownerNumbers: run.ownerNumbers,
      enforceFinalTag: true,
      provider: "openai",
      model: "gpt-4.1-mini",
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
      thinkLevel: run.thinkLevel,
      verboseLevel: run.verboseLevel,
      reasoningLevel: run.reasoningLevel,
      execOverrides: run.execOverrides,
      bashElevated: run.bashElevated,
      timeoutMs: run.timeoutMs,
      runId: "run-1",
    });
  });

  it("builds embedded contexts and scopes auth profile by provider", () => {
    const run = makeRun({
      authProfileId: "profile-openai",
      authProfileIdSource: "auto",
    });

    const resolved = buildEmbeddedRunContexts({
      run,
      sessionCtx: {
        Provider: "OpenAI",
        To: "channel-1",
        SenderId: "sender-1",
      },
      hasRepliedRef: undefined,
      provider: "anthropic",
    });

    expect(resolved.authProfile).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(resolved.embeddedContext).toMatchObject({
      sessionId: run.sessionId,
      sessionKey: run.sessionKey,
      agentId: run.agentId,
      messageProvider: "openai",
      messageTo: "channel-1",
    });
    expect(resolved.senderContext).toEqual({
      senderId: "sender-1",
      senderName: undefined,
      senderUsername: undefined,
      senderE164: undefined,
    });
  });

  it("prefers OriginatingChannel over Provider for messageProvider", () => {
    const run = makeRun();

    const resolved = buildEmbeddedRunContexts({
      run,
      sessionCtx: {
        Provider: "heartbeat",
        OriginatingChannel: "Telegram",
        OriginatingTo: "268300329",
      },
      hasRepliedRef: undefined,
      provider: "openai",
    });

    expect(resolved.embeddedContext.messageProvider).toBe("telegram");
    expect(resolved.embeddedContext.messageTo).toBe("268300329");
  });
});
