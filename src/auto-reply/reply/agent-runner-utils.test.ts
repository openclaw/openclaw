import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveRunModelFallbacksOverrideMock = vi.fn();
  const resolveEffectiveModelFallbacksMock = vi.fn();
  const resolveFallbackAgentIdMock = vi.fn();
  return {
    resolveRunModelFallbacksOverrideMock,
    resolveEffectiveModelFallbacksMock,
    resolveFallbackAgentIdMock,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveEffectiveModelFallbacks: (...args: unknown[]) =>
    hoisted.resolveEffectiveModelFallbacksMock(...args),
  resolveFallbackAgentId: (...args: unknown[]) => hoisted.resolveFallbackAgentIdMock(...args),
  resolveRunModelFallbacksOverride: (...args: unknown[]) =>
    hoisted.resolveRunModelFallbacksOverrideMock(...args),
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
    hoisted.resolveRunModelFallbacksOverrideMock.mockClear();
    hoisted.resolveEffectiveModelFallbacksMock.mockClear();
    hoisted.resolveFallbackAgentIdMock.mockClear();
    hoisted.resolveFallbackAgentIdMock.mockImplementation(
      (params: { agentId?: string; sessionKey?: string }) =>
        params.agentId ?? `derived:${params.sessionKey ?? ""}`,
    );
  });

  it("resolves model fallback options from run context", () => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(["fallback-model"]);
    const run = makeRun();

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveRunModelFallbacksOverrideMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
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
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({ agentId: undefined });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveRunModelFallbacksOverrideMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: undefined,
      sessionKey: run.sessionKey,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("uses effective fallback resolution when session model override is present", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["default-fallback"]);
    const run = makeRun();

    const resolved = resolveModelFallbackOptions(run, {
      modelOverride: "override-model",
    });

    expect(hoisted.resolveFallbackAgentIdMock).toHaveBeenCalledWith({
      agentId: run.agentId,
      sessionKey: run.sessionKey,
    });
    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      hasSessionModelOverride: true,
    });
    expect(hoisted.resolveRunModelFallbacksOverrideMock).not.toHaveBeenCalled();
    expect(resolved.fallbacksOverride).toEqual(["default-fallback"]);
  });

  it("derives the agent id from sessionKey for effective fallback resolution", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["derived-fallback"]);
    const run = makeRun({
      agentId: undefined,
      sessionKey: "agent:derived-agent:session",
    });

    const resolved = resolveModelFallbackOptions(run, {
      modelOverride: "override-model",
    });

    expect(hoisted.resolveFallbackAgentIdMock).toHaveBeenCalledWith({
      agentId: undefined,
      sessionKey: "agent:derived-agent:session",
    });
    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: "derived:agent:derived-agent:session",
      hasSessionModelOverride: true,
    });
    expect(resolved.fallbacksOverride).toEqual(["derived-fallback"]);
  });

  it("uses effective fallback resolution with hasSessionModelOverride=false when session overrides are absent", () => {
    hoisted.resolveEffectiveModelFallbacksMock.mockReturnValue(["agent-specific-fallback"]);
    const run = makeRun();

    const resolved = resolveModelFallbackOptions(run, {
      modelOverride: "",
      providerOverride: "",
    });

    expect(hoisted.resolveEffectiveModelFallbacksMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      hasSessionModelOverride: false,
    });
    expect(hoisted.resolveRunModelFallbacksOverrideMock).not.toHaveBeenCalled();
    expect(resolved.fallbacksOverride).toEqual(["agent-specific-fallback"]);
  });

  it("falls back to safe run-based resolution when config is missing", () => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(undefined);
    const run = makeRun({
      config: undefined,
      agentId: undefined,
    });

    const resolved = resolveModelFallbackOptions(run, {
      modelOverride: "override-model",
    });

    expect(hoisted.resolveEffectiveModelFallbacksMock).not.toHaveBeenCalled();
    expect(hoisted.resolveRunModelFallbacksOverrideMock).toHaveBeenCalledWith({
      cfg: undefined,
      agentId: undefined,
      sessionKey: run.sessionKey,
    });
    expect(resolved.fallbacksOverride).toBeUndefined();
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
