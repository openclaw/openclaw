import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveAgentModelFallbacksOverrideMock = vi.fn();
  const resolveAgentIdFromSessionKeyMock = vi.fn();
  return { resolveAgentModelFallbacksOverrideMock, resolveAgentIdFromSessionKeyMock };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentModelFallbacksOverride: (...args: unknown[]) =>
    hoisted.resolveAgentModelFallbacksOverrideMock(...args),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: (...args: unknown[]) =>
    hoisted.resolveAgentIdFromSessionKeyMock(...args),
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
    hoisted.resolveAgentModelFallbacksOverrideMock.mockReset();
    hoisted.resolveAgentIdFromSessionKeyMock.mockReset();
  });

  it("resolves model fallback options from run context", () => {
    hoisted.resolveAgentIdFromSessionKeyMock.mockReturnValue("agent-id");
    hoisted.resolveAgentModelFallbacksOverrideMock.mockReturnValue(["fallback-model"]);
    const run = makeRun();

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveAgentIdFromSessionKeyMock).toHaveBeenCalledWith(run.sessionKey);
    expect(hoisted.resolveAgentModelFallbacksOverrideMock).toHaveBeenCalledWith(
      run.config,
      "agent-id",
    );
    expect(resolved).toEqual({
      cfg: run.config,
      provider: run.provider,
      model: run.model,
      agentDir: run.agentDir,
      fallbacksOverride: ["fallback-model"],
    });
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
});
