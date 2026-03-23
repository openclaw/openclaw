/**
 * Observability tests for the policy feedback engine.
 *
 * Validates the debug/inspect methods: getDebugInfo, getStatus,
 * explainScore, and getRecentHistory.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config.js";
import { PolicyFeedbackEngineImpl } from "./engine.js";
import type { PolicyFeedbackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-obs-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getDebugInfo
// ---------------------------------------------------------------------------

describe("getDebugInfo", () => {
  it("returns expected structure with all required fields", () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    const debug = engine.getDebugInfo();

    expect(debug).toEqual(
      expect.objectContaining({
        mode: "passive",
        storageDir: tmpDir,
        actionCount: 0,
        outcomeCount: 0,
        constraintRules: 0,
        lastError: undefined,
        lastActionTime: undefined,
      }),
    );
    // Feature flags should be present
    expect(debug.featureFlags).toBeDefined();
    expect(debug.featureFlags.enableActionLogging).toBe(true);
    // Aggregate summary should be present
    expect(debug.aggregateSummary).toBeDefined();
    expect(debug.aggregateSummary?.totalActions).toBe(0);
    // Active constraints includes built-in defaults
    expect(debug.activeConstraints).toBeInstanceOf(Array);
    expect(debug.activeConstraints.length).toBeGreaterThan(0);
  });

  it("reflects action and outcome counts after logging", async () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    await engine.logAction({
      agentId: "agent-1",
      sessionKey: "sess-1",
      actionType: "agent_reply",
      channelId: "telegram",
    });

    const debug = engine.getDebugInfo();
    expect(debug.actionCount).toBe(1);
    expect(debug.lastActionTime).toBeTruthy();
  });

  it("includes feature flags matching the current mode", () => {
    const config: PolicyFeedbackConfig = { ...getDefaultConfig(), mode: "off" };
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    const debug = engine.getDebugInfo();
    expect(debug.mode).toBe("off");
    expect(debug.featureFlags.enableActionLogging).toBe(false);
    expect(debug.featureFlags.enableRanking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe("getStatus", () => {
  it("returns correct initial counts", () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    const status = engine.getStatus();
    expect(status.mode).toBe("passive");
    expect(status.actionLogSize).toBe(0);
    expect(status.outcomeLogSize).toBe(0);
    expect(status.constraintRulesLoaded).toBe(0);
    expect(status.lastError).toBeUndefined();
    expect(status.aggregatesStale).toBe(true);
  });

  it("increments action count after logAction", async () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    await engine.logAction({
      agentId: "agent-1",
      sessionKey: "sess-1",
      actionType: "agent_reply",
      channelId: "telegram",
    });
    await engine.logAction({
      agentId: "agent-1",
      sessionKey: "sess-1",
      actionType: "tool_call",
      channelId: "telegram",
    });

    const status = engine.getStatus();
    expect(status.actionLogSize).toBe(2);
  });

  it("increments outcome count after logOutcome", async () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    const { actionId } = await engine.logAction({
      agentId: "agent-1",
      sessionKey: "sess-1",
      actionType: "agent_reply",
      channelId: "telegram",
    });

    await engine.logOutcome({
      actionId,
      agentId: "agent-1",
      outcomeType: "user_replied",
    });

    const status = engine.getStatus();
    expect(status.actionLogSize).toBe(1);
    expect(status.outcomeLogSize).toBe(1);
  });

  it("reflects constraint rules from config", () => {
    const config: PolicyFeedbackConfig = {
      ...getDefaultConfig(),
      constraints: [
        {
          id: "test-rule",
          description: "Test constraint",
          condition: { type: "consecutive_ignores", threshold: 5 },
          action: "suppress",
          priority: 1,
        },
      ],
    };
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    const status = engine.getStatus();
    expect(status.constraintRulesLoaded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// explainScore
// ---------------------------------------------------------------------------

describe("explainScore", () => {
  it("returns a score breakdown with factors", async () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    const breakdown = await engine.explainScore("candidate-1", {
      channelId: "telegram",
    });

    expect(breakdown).toBeDefined();
    expect(breakdown!.candidateId).toBe("candidate-1");
    expect(breakdown!.finalScore).toBeGreaterThanOrEqual(0);
    expect(breakdown!.finalScore).toBeLessThanOrEqual(1);
    expect(breakdown!.factors).toBeInstanceOf(Array);
    expect(breakdown!.factors.length).toBeGreaterThan(0);
    // Should have at least the "Base score" factor
    const baseScoreFactor = breakdown!.factors.find((f) => f.name === "Base score");
    expect(baseScoreFactor).toBeDefined();
    expect(baseScoreFactor!.value).toBe(50);
  });

  it("reflects context in the score breakdown", async () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    // High fatigue context should produce fatigue-related factors
    const breakdown = await engine.explainScore("candidate-2", {
      channelId: "telegram",
      recentActionCount: 5,
    });

    expect(breakdown).toBeDefined();
    expect(breakdown!.factors.length).toBeGreaterThan(1);
    // Should include an intervention fatigue factor
    const fatigueFactor = breakdown!.factors.find((f) => f.name.toLowerCase().includes("fatigue"));
    expect(fatigueFactor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getRecentHistory
// ---------------------------------------------------------------------------

describe("getRecentHistory", () => {
  it("returns paired action+outcomes", async () => {
    // Disable per-agent scoping so actions and outcomes share the same path,
    // allowing queryOutcomes (which reads from global scope) to find them.
    const config: PolicyFeedbackConfig = { ...getDefaultConfig(), perAgentScoping: false };
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    // Log an action and outcome
    const { actionId } = await engine.logAction({
      agentId: "agent-1",
      sessionKey: "sess-1",
      actionType: "agent_reply",
      channelId: "telegram",
    });

    await engine.logOutcome({
      actionId,
      agentId: "agent-1",
      outcomeType: "user_replied",
      value: 1,
    });

    const history = await engine.getRecentHistory("agent-1");
    expect(history.length).toBe(1);
    expect(history[0].action.id).toBe(actionId);
    expect(history[0].action.actionType).toBe("agent_reply");
    expect(history[0].outcomes.length).toBe(1);
    expect(history[0].outcomes[0].outcomeType).toBe("user_replied");
  });

  it("returns empty array for unknown user", async () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    const history = await engine.getRecentHistory("nonexistent-agent");
    expect(history).toEqual([]);
  });

  it("respects the limit parameter", async () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    // Log several actions
    for (let i = 0; i < 5; i++) {
      await engine.logAction({
        agentId: "agent-1",
        sessionKey: "sess-1",
        actionType: "agent_reply",
        channelId: "telegram",
      });
    }

    const history = await engine.getRecentHistory("agent-1", 2);
    expect(history.length).toBe(2);
  });

  it("returns actions without outcomes when none are logged", async () => {
    const config = getDefaultConfig();
    const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

    await engine.logAction({
      agentId: "agent-1",
      sessionKey: "sess-1",
      actionType: "tool_call",
      channelId: "discord",
    });

    const history = await engine.getRecentHistory("agent-1");
    expect(history.length).toBe(1);
    expect(history[0].outcomes).toEqual([]);
  });
});
