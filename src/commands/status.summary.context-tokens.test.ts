/**
 * Tests for issue #18696:
 * Status display should prefer user-configured contextTokens over the model catalog contextWindow.
 *
 * When contextTokens is configured (e.g., 1_000_000 for Claude Max), the status command
 * should show the user-configured value rather than the model catalog's contextWindow (200K).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks so they're available before imports
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
  resolveMainSessionKey: vi.fn().mockReturnValue("agent:main:main"),
  resolveFreshSessionTotalTokens: vi.fn(),
  lookupContextTokens: vi.fn(),
  resolveConfiguredModelRef: vi.fn(),
  listAgentsForGateway: vi.fn(),
  buildChannelSummary: vi.fn(),
  resolveHeartbeatSummaryForAgent: vi.fn(),
  peekSystemEvents: vi.fn(),
  resolveLinkChannelContext: vi.fn(),
  classifySessionKey: vi.fn(),
  parseAgentSessionKey: vi.fn(),
}));

vi.mock("../agents/context.js", () => ({
  lookupContextTokens: mocks.lookupContextTokens,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveStorePath: mocks.resolveStorePath,
  resolveMainSessionKey: mocks.resolveMainSessionKey,
  resolveFreshSessionTotalTokens: mocks.resolveFreshSessionTotalTokens,
}));

vi.mock("../agents/model-selection.js", () => ({
  resolveConfiguredModelRef: mocks.resolveConfiguredModelRef,
}));

vi.mock("../gateway/session-utils.js", () => ({
  listAgentsForGateway: mocks.listAgentsForGateway,
  classifySessionKey: mocks.classifySessionKey,
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

vi.mock("../routing/session-key.js", () => ({
  parseAgentSessionKey: mocks.parseAgentSessionKey,
}));

import { getStatusSummary } from "./status.summary.js";

function setupBaseMocks(cfg: Record<string, unknown>) {
  mocks.loadConfig.mockReturnValue(cfg);
  mocks.resolveConfiguredModelRef.mockReturnValue({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  mocks.listAgentsForGateway.mockReturnValue({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "per-sender",
    agents: [{ id: "main", name: "Main" }],
  });
  mocks.resolveHeartbeatSummaryForAgent.mockReturnValue({
    enabled: false,
    every: "5m",
    everyMs: 300_000,
  });
  mocks.buildChannelSummary.mockResolvedValue([]);
  mocks.peekSystemEvents.mockReturnValue([]);
  mocks.resolveLinkChannelContext.mockResolvedValue(null);
  mocks.classifySessionKey.mockReturnValue("direct");
  mocks.parseAgentSessionKey.mockReturnValue({ agentId: "main", rest: "main" });
}

describe("getStatusSummary contextTokens priority (#18696)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses user-configured contextTokens when it exceeds model catalog value", async () => {
    // User configured 1M tokens (e.g., Claude Max plan)
    const userConfiguredContextTokens = 1_000_000;
    // Model catalog reports 200K
    const modelCatalogContextTokens = 200_000;

    setupBaseMocks({
      session: {},
      agents: { defaults: { contextTokens: userConfiguredContextTokens } },
    });

    // Session has no per-session contextTokens override
    const sessionEntry = {
      updatedAt: Date.now() - 60_000,
      totalTokens: 50_000,
      model: "claude-sonnet-4-5",
      sessionId: "test-session-id",
      systemSent: true,
    };
    mocks.loadSessionStore.mockReturnValue({ "agent:main:main": sessionEntry });
    mocks.resolveFreshSessionTotalTokens.mockReturnValue(50_000);

    // Model catalog returns 200K for this model
    mocks.lookupContextTokens.mockReturnValue(modelCatalogContextTokens);

    const summary = await getStatusSummary();

    const recent = summary.sessions.recent;
    expect(recent.length).toBeGreaterThan(0);
    const session = recent[0];

    // Should show user-configured 1M, NOT the catalog's 200K
    expect(session.contextTokens).toBe(userConfiguredContextTokens);
    expect(session.contextTokens).not.toBe(modelCatalogContextTokens);

    // Percentage should be based on 1M context, not 200K
    // 50K / 1M = 5%
    expect(session.percentUsed).toBe(5);
    // Remaining = 1M - 50K = 950K
    expect(session.remainingTokens).toBe(950_000);
  });

  it("falls back to model catalog value when no user config is set", async () => {
    const modelCatalogContextTokens = 200_000;

    setupBaseMocks({ session: {} }); // No agents.defaults.contextTokens

    const sessionEntry = {
      updatedAt: Date.now() - 60_000,
      totalTokens: 10_000,
      model: "claude-sonnet-4-5",
      sessionId: "test-session-id-2",
      systemSent: true,
    };
    mocks.loadSessionStore.mockReturnValue({ "agent:main:main": sessionEntry });
    mocks.resolveFreshSessionTotalTokens.mockReturnValue(10_000);

    // Model catalog returns 200K for this model
    mocks.lookupContextTokens.mockReturnValue(modelCatalogContextTokens);

    const summary = await getStatusSummary();

    const recent = summary.sessions.recent;
    expect(recent.length).toBeGreaterThan(0);
    const session = recent[0];

    // Should use catalog value (200K) when no user config
    expect(session.contextTokens).toBe(modelCatalogContextTokens);
  });

  it("uses per-session contextTokens override over both user config and catalog", async () => {
    const userConfiguredContextTokens = 1_000_000;
    const perSessionContextTokens = 50_000;
    const modelCatalogContextTokens = 200_000;

    setupBaseMocks({
      session: {},
      agents: { defaults: { contextTokens: userConfiguredContextTokens } },
    });

    // Session has an explicit per-session override
    const sessionEntry = {
      updatedAt: Date.now() - 60_000,
      totalTokens: 5_000,
      contextTokens: perSessionContextTokens,
      model: "claude-sonnet-4-5",
      sessionId: "test-session-id-3",
      systemSent: true,
    };
    mocks.loadSessionStore.mockReturnValue({ "agent:main:main": sessionEntry });
    mocks.resolveFreshSessionTotalTokens.mockReturnValue(5_000);

    mocks.lookupContextTokens.mockReturnValue(modelCatalogContextTokens);

    const summary = await getStatusSummary();

    const recent = summary.sessions.recent;
    expect(recent.length).toBeGreaterThan(0);
    const session = recent[0];

    // Per-session override should win
    expect(session.contextTokens).toBe(perSessionContextTokens);
  });

  it("shows user-configured contextTokens in defaults when larger than model catalog", async () => {
    const userConfiguredContextTokens = 1_000_000;
    const modelCatalogContextTokens = 200_000;

    setupBaseMocks({
      session: {},
      agents: { defaults: { contextTokens: userConfiguredContextTokens } },
    });

    mocks.loadSessionStore.mockReturnValue({});
    mocks.lookupContextTokens.mockReturnValue(modelCatalogContextTokens);

    const summary = await getStatusSummary();

    // The defaults should also show the user-configured value
    expect(summary.sessions.defaults.contextTokens).toBe(userConfiguredContextTokens);
  });
});
