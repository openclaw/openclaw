import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config.js";
import { PolicyFeedbackEngineImpl, createPolicyFeedbackEngine } from "./engine.js";
import type { PolicyFeedbackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-engine-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PolicyFeedbackEngineImpl", () => {
  describe("logAction", () => {
    it("returns an action ID on success", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      const result = await engine.logAction({
        agentId: "agent-1",
        sessionKey: "sess-1",
        actionType: "agent_reply",
        channelId: "telegram",
      });

      expect(result.actionId).toBeTruthy();
      expect(result.actionId).not.toBe("error");
    });

    it("never throws — returns error ID on failure", async () => {
      // Use an invalid storage dir that will cause write failure
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl("/dev/null/bad", config);

      const result = await engine.logAction({
        agentId: "agent-1",
        sessionKey: "sess-1",
        actionType: "agent_reply",
        channelId: "telegram",
      });

      // Should not throw, returns some actionId
      expect(result.actionId).toBeTruthy();
    });
  });

  describe("logOutcome", () => {
    it("logs an outcome without throwing", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      // First log an action to get an ID
      const { actionId } = await engine.logAction({
        agentId: "agent-1",
        sessionKey: "sess-1",
        actionType: "agent_reply",
        channelId: "telegram",
      });

      // Then log an outcome
      await expect(
        engine.logOutcome({
          actionId,
          agentId: "agent-1",
          outcomeType: "user_replied",
        }),
      ).resolves.toBeUndefined();
    });

    it("never throws on failure", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl("/dev/null/bad", config);

      await expect(
        engine.logOutcome({
          actionId: "nonexistent",
          agentId: "agent-1",
          outcomeType: "user_silent",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("rankCandidates", () => {
    it("returns scored candidates", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      const result = await engine.rankCandidates({
        agentId: "agent-1",
        sessionKey: "sess-1",
        candidates: [
          { id: "c1", actionType: "agent_reply" },
          { id: "c2", actionType: "no_op" },
        ],
        context: { channelId: "telegram" },
      });

      expect(result).toHaveLength(2);
      expect(result[0].score).toBeGreaterThanOrEqual(0);
      expect(result[0].score).toBeLessThanOrEqual(1);
    });

    it("returns neutral scores on internal failure", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      // Mock the ranker to throw
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spying on private getter for test
      vi.spyOn(engine as any, "ranker", "get").mockImplementation(() => {
        throw new Error("mock failure");
      });

      const result = await engine.rankCandidates({
        agentId: "agent-1",
        sessionKey: "sess-1",
        candidates: [{ id: "c1", actionType: "agent_reply" }],
        context: { channelId: "telegram" },
      });

      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(0.5);
      expect(result[0].suppress).toBe(false);
    });
  });

  describe("getPolicyHints", () => {
    it("returns policy hints", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      const hints = await engine.getPolicyHints({
        agentId: "agent-1",
        sessionKey: "sess-1",
        channelId: "telegram",
      });

      expect(hints.mode).toBe("passive");
      expect(hints.fatigueLevel).toBeGreaterThanOrEqual(0);
      expect(hints.recommendation).toBeDefined();
    });

    it("returns safe defaults on failure", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spying on private getter for test
      vi.spyOn(engine as any, "ranker", "get").mockImplementation(() => {
        throw new Error("mock failure");
      });

      const hints = await engine.getPolicyHints({
        agentId: "agent-1",
        sessionKey: "sess-1",
        channelId: "telegram",
      });

      expect(hints.recommendation).toBe("proceed");
      expect(hints.mode).toBe("passive");
    });
  });

  describe("recomputeAggregates", () => {
    it("completes without throwing", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      await expect(engine.recomputeAggregates("agent-1")).resolves.toBeUndefined();
    });
  });

  describe("getStatus", () => {
    it("returns current status", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      const status = engine.getStatus();
      expect(status.mode).toBe("passive");
      expect(status.actionLogSize).toBe(0);
      expect(status.outcomeLogSize).toBe(0);
      expect(status.constraintRulesLoaded).toBe(0);
    });

    it("tracks action and outcome counts", async () => {
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
  });

  describe("getMode", () => {
    it("returns the configured mode", () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        mode: "advisory",
      };
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);
      expect(engine.getMode()).toBe("advisory");
    });
  });

  describe("getDebugInfo", () => {
    it("returns a state summary", () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      const debug = engine.getDebugInfo();
      expect(debug.mode).toBe("passive");
      expect(debug.storageDir).toBe(tmpDir);
      expect(debug.actionCount).toBe(0);
      expect(debug.activeConstraints).toBeInstanceOf(Array);
      expect(debug.activeConstraints.length).toBeGreaterThan(0);
    });
  });

  describe("full lifecycle", () => {
    it("logAction -> logOutcome -> rankCandidates flow", async () => {
      const config = getDefaultConfig();
      const engine = new PolicyFeedbackEngineImpl(tmpDir, config);

      // Log some actions
      const { actionId: id1 } = await engine.logAction({
        agentId: "agent-1",
        sessionKey: "sess-1",
        actionType: "agent_reply",
        channelId: "telegram",
      });
      const { actionId: id2 } = await engine.logAction({
        agentId: "agent-1",
        sessionKey: "sess-1",
        actionType: "cron_run",
        channelId: "telegram",
      });

      // Log outcomes
      await engine.logOutcome({
        actionId: id1,
        agentId: "agent-1",
        outcomeType: "user_replied",
      });
      await engine.logOutcome({
        actionId: id2,
        agentId: "agent-1",
        outcomeType: "user_silent",
      });

      // Recompute aggregates
      await engine.recomputeAggregates("agent-1");

      // Rank candidates
      const ranked = await engine.rankCandidates({
        agentId: "agent-1",
        sessionKey: "sess-1",
        candidates: [
          { id: "c1", actionType: "agent_reply" },
          { id: "c2", actionType: "cron_run" },
          { id: "c3", actionType: "no_op" },
        ],
        context: { channelId: "telegram" },
      });

      expect(ranked).toHaveLength(3);
      // All should have scores
      for (const r of ranked) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(r.reasons.length).toBeGreaterThan(0);
      }

      // Verify status reflects the logged data
      const status = engine.getStatus();
      expect(status.actionLogSize).toBe(2);
      expect(status.outcomeLogSize).toBe(2);
    });
  });

  describe("mode: off", () => {
    it("still completes all operations without error", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        mode: "off",
      };
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

      const ranked = await engine.rankCandidates({
        agentId: "agent-1",
        sessionKey: "sess-1",
        candidates: [{ id: "c1", actionType: "agent_reply" }],
        context: { channelId: "telegram" },
      });

      // In off mode, ranking returns base scores
      expect(ranked).toHaveLength(1);
      expect(ranked[0].score).toBe(0.5);

      expect(engine.getMode()).toBe("off");
    });
  });
});

describe("createPolicyFeedbackEngine", () => {
  it("creates an engine with defaults", async () => {
    const engine = await createPolicyFeedbackEngine({
      home: tmpDir,
    });

    expect(engine).toBeInstanceOf(PolicyFeedbackEngineImpl);
    expect(engine.getMode()).toBe("passive");
  });

  it("applies config overrides", async () => {
    const engine = await createPolicyFeedbackEngine({
      home: tmpDir,
      config: { mode: "advisory" },
    });

    expect(engine.getMode()).toBe("advisory");
  });
});
