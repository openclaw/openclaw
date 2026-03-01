import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_OVERRIDE_MODEL = "custom-agent-model";
const DEFAULT_MODEL = "default-model";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveMainSessionKey: vi.fn().mockReturnValue("agent:main:work"),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
  resolveFreshSessionTotalTokens: vi.fn(() => undefined),
  resolveSessionModelRef: vi.fn(),
  listAgentsForGateway: vi.fn(),
  classifySessionKey: vi.fn().mockReturnValue("direct"),
  buildChannelSummary: vi.fn().mockResolvedValue([]),
  resolveHeartbeatSummaryForAgent: vi.fn().mockReturnValue({
    enabled: false,
    every: "5m",
    everyMs: 300_000,
  }),
  peekSystemEvents: vi.fn().mockReturnValue([]),
  resolveLinkChannelContext: vi.fn().mockResolvedValue(null),
  resolveConfiguredModelRef: vi.fn(),
  resolveContextTokensForModel: vi.fn().mockReturnValue(128_000),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveMainSessionKey: mocks.resolveMainSessionKey,
  resolveStorePath: mocks.resolveStorePath,
  resolveFreshSessionTotalTokens: mocks.resolveFreshSessionTotalTokens,
}));

vi.mock("../gateway/session-utils.js", () => ({
  classifySessionKey: mocks.classifySessionKey,
  listAgentsForGateway: mocks.listAgentsForGateway,
  resolveSessionModelRef: mocks.resolveSessionModelRef,
}));

vi.mock("../infra/channel-summary.js", () => ({
  buildChannelSummary: mocks.buildChannelSummary,
}));

vi.mock("../infra/heartbeat-runner.js", () => ({
  resolveHeartbeatSummaryForAgent: mocks.resolveHeartbeatSummaryForAgent,
}));

vi.mock("../infra/system-events.js", () => ({
  peekSystemEvents: mocks.peekSystemEvents,
}));

vi.mock("./status.link-channel.js", () => ({
  resolveLinkChannelContext: mocks.resolveLinkChannelContext,
}));

vi.mock("../agents/model-selection.js", () => ({
  resolveConfiguredModelRef: mocks.resolveConfiguredModelRef,
}));

vi.mock("../agents/context.js", () => ({
  resolveContextTokensForModel: mocks.resolveContextTokensForModel,
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 128_000,
  DEFAULT_MODEL: "default-model",
  DEFAULT_PROVIDER: "default-provider",
}));

describe("getStatusSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.loadConfig.mockReturnValue({
      agents: { defaults: { model: { primary: DEFAULT_MODEL } } },
    });

    mocks.resolveConfiguredModelRef.mockReturnValue({
      provider: "default-provider",
      model: DEFAULT_MODEL,
    });

    mocks.listAgentsForGateway.mockReturnValue({
      defaultId: "main",
      mainKey: "agent:main:work",
      scope: "per-sender",
      agents: [{ id: "research", name: "Research" }],
    });

    mocks.loadSessionStore.mockReturnValue({
      "agent:research:work": {
        updatedAt: Date.now() - 60_000,
        sessionId: "sess-1",
      },
    });
  });

  it("uses per-agent model for sessions in the allSessions (recent) list", async () => {
    // resolveSessionModelRef should receive the agent ID parsed from the key
    // even when buildSessionRows is called without agentIdOverride (the allSessions path).
    mocks.resolveSessionModelRef.mockImplementation(
      (_cfg: unknown, _entry: unknown, agentId?: string) => {
        if (agentId === "research") {
          return { provider: "custom-provider", model: AGENT_OVERRIDE_MODEL };
        }
        return { provider: "default-provider", model: DEFAULT_MODEL };
      },
    );

    const { getStatusSummary } = await import("./status.summary.js");
    const summary = await getStatusSummary();

    // The "recent" list comes from the allSessions path (no agentIdOverride).
    // Before the fix, agentId was computed AFTER resolveSessionModelRef, so
    // the model would incorrectly be the global default.
    const recentSession = summary.sessions.recent[0];
    expect(recentSession).toBeDefined();
    expect(recentSession?.model).toBe(AGENT_OVERRIDE_MODEL);

    // Verify resolveSessionModelRef was called with the agent ID parsed from the key.
    // It's called twice: once for byAgent (with agentIdOverride) and once for allSessions.
    // Both should pass "research" as the agentId.
    const calls = mocks.resolveSessionModelRef.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Every call should include "research" as the agentId argument.
    for (const call of calls) {
      expect(call[2]).toBe("research");
    }
  });
});
