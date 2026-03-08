import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveRunModelFallbacksOverrideMock = vi.fn();
  return { resolveRunModelFallbacksOverrideMock };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveRunModelFallbacksOverride: (...args: unknown[]) =>
    hoisted.resolveRunModelFallbacksOverrideMock(...args),
}));

const {
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunContexts,
  formatResponseUsageLine,
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

  describe("formatResponseUsageLine", () => {
    it("returns null when usage is undefined", () => {
      expect(formatResponseUsageLine({ showCost: false })).toBeNull();
    });

    it("formats basic usage without call count for single call", () => {
      const result = formatResponseUsageLine({
        usage: { input: 1000, output: 200, callCount: 1 },
        showCost: false,
      });
      expect(result).toBe("Usage: 1.0k in / 200 out");
    });

    it("includes call count when multiple calls are made", () => {
      const result = formatResponseUsageLine({
        usage: { input: 60000, output: 150, callCount: 3 },
        showCost: false,
      });
      expect(result).toBe("Usage: 60k in / 150 out (3 calls)");
    });

    it("omits call count when callCount is undefined", () => {
      const result = formatResponseUsageLine({
        usage: { input: 5000, output: 100 },
        showCost: false,
      });
      expect(result).toBe("Usage: 5.0k in / 100 out");
    });

    it("includes call count before cost suffix", () => {
      const result = formatResponseUsageLine({
        usage: { input: 10000, output: 500, callCount: 2 },
        showCost: true,
        costConfig: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      });
      expect(result).toContain("(2 calls)");
      expect(result).toContain("est $");
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
