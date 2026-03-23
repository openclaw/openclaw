import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config.js";
import { OutcomeTracker } from "./outcomes.js";
import { readOutcomes } from "./persistence.js";
import type { LogOutcomeInput, PolicyFeedbackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOutcomeInput(overrides?: Partial<LogOutcomeInput>): LogOutcomeInput {
  return {
    actionId: "act-001",
    agentId: "agent-1",
    outcomeType: "delivery_success",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-outcomes-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OutcomeTracker", () => {
  describe("logOutcome", () => {
    it("creates an OutcomeRecord with a unique ID and persists it", async () => {
      const config = getDefaultConfig();
      const tracker = new OutcomeTracker(tmpDir, config);
      const input = makeOutcomeInput();

      const record = await tracker.logOutcome(input);

      expect(record.id).toBeDefined();
      expect(typeof record.id).toBe("string");
      expect(record.actionId).toBe("act-001");
      expect(record.agentId).toBe("agent-1");
      expect(record.outcomeType).toBe("delivery_success");
      expect(record.timestamp).toBeDefined();

      // Verify persisted (per-agent scoping)
      const stored = await readOutcomes({ agentId: "agent-1", home: tmpDir });
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(record.id);
    });

    it("generates unique IDs for each outcome", async () => {
      const config = getDefaultConfig();
      const tracker = new OutcomeTracker(tmpDir, config);

      const r1 = await tracker.logOutcome(makeOutcomeInput());
      const r2 = await tracker.logOutcome(makeOutcomeInput());

      expect(r1.id).not.toBe(r2.id);
    });

    it("links to the correct actionId", async () => {
      const config = getDefaultConfig();
      const tracker = new OutcomeTracker(tmpDir, config);

      const r1 = await tracker.logOutcome(makeOutcomeInput({ actionId: "act-AAA" }));
      const r2 = await tracker.logOutcome(makeOutcomeInput({ actionId: "act-BBB" }));

      expect(r1.actionId).toBe("act-AAA");
      expect(r2.actionId).toBe("act-BBB");
    });

    it("includes optional fields when provided", async () => {
      const config = getDefaultConfig();
      const tracker = new OutcomeTracker(tmpDir, config);

      const record = await tracker.logOutcome(
        makeOutcomeInput({
          value: 0.85,
          horizonMs: 60_000,
          metadata: { source: "webhook" },
        }),
      );

      expect(record.value).toBe(0.85);
      expect(record.horizonMs).toBe(60_000);
      expect(record.metadata).toEqual({ source: "webhook" });
    });

    it("is a no-op when enableOutcomeLogging is false (mode=off)", async () => {
      const config: PolicyFeedbackConfig = { ...getDefaultConfig(), mode: "off" };
      const tracker = new OutcomeTracker(tmpDir, config);

      const record = await tracker.logOutcome(makeOutcomeInput());

      // Still returns a record
      expect(record.id).toBeDefined();

      // But nothing persisted
      const stored = await readOutcomes({ home: tmpDir });
      expect(stored).toHaveLength(0);
      const agentStored = await readOutcomes({ agentId: "agent-1", home: tmpDir });
      expect(agentStored).toHaveLength(0);
    });

    it("never throws on persistence error", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const tracker = new OutcomeTracker(tmpDir, config);

      // Create a directory where the file should be to cause an error
      const blockerPath = path.join(tmpDir, ".openclaw", "policy-feedback", "outcomes.jsonl");
      await fs.mkdir(blockerPath, { recursive: true });

      // Should not throw, returns a record (error is logged via subsystem logger)
      const record = await tracker.logOutcome(makeOutcomeInput());
      expect(record.id).toBeDefined();
    });
  });

  describe("queryOutcomes", () => {
    it("returns all outcomes when no filter is specified", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const tracker = new OutcomeTracker(tmpDir, config);

      await tracker.logOutcome(makeOutcomeInput({ actionId: "act-1" }));
      await tracker.logOutcome(makeOutcomeInput({ actionId: "act-2" }));

      const results = await tracker.queryOutcomes({});
      expect(results).toHaveLength(2);
    });

    it("filters by actionId", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const tracker = new OutcomeTracker(tmpDir, config);

      await tracker.logOutcome(makeOutcomeInput({ actionId: "act-1" }));
      await tracker.logOutcome(makeOutcomeInput({ actionId: "act-2" }));
      await tracker.logOutcome(makeOutcomeInput({ actionId: "act-1" }));

      const results = await tracker.queryOutcomes({ actionId: "act-1" });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.actionId === "act-1")).toBe(true);
    });

    it("filters by since timestamp", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const tracker = new OutcomeTracker(tmpDir, config);

      await tracker.logOutcome(makeOutcomeInput());
      // Add 1ms to ensure the cutoff falls strictly after the first record
      const cutoff = Date.now() + 1;
      await new Promise((r) => setTimeout(r, 5));
      await tracker.logOutcome(makeOutcomeInput());

      const results = await tracker.queryOutcomes({ since: cutoff });
      expect(results).toHaveLength(1);
    });

    it("respects limit parameter", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const tracker = new OutcomeTracker(tmpDir, config);

      for (let i = 0; i < 5; i++) {
        await tracker.logOutcome(makeOutcomeInput());
      }

      const results = await tracker.queryOutcomes({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it("returns empty array on error", async () => {
      const config = getDefaultConfig();
      const tracker = new OutcomeTracker(tmpDir, config);

      const results = await tracker.queryOutcomes({});
      expect(results).toEqual([]);
    });
  });

  describe("getOutcomesForAction", () => {
    it("returns outcomes linked to a specific action", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const tracker = new OutcomeTracker(tmpDir, config);

      await tracker.logOutcome(makeOutcomeInput({ actionId: "act-X" }));
      await tracker.logOutcome(makeOutcomeInput({ actionId: "act-Y" }));
      await tracker.logOutcome(
        makeOutcomeInput({ actionId: "act-X", outcomeType: "user_replied" }),
      );

      const results = await tracker.getOutcomesForAction("act-X");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.actionId === "act-X")).toBe(true);
    });

    it("returns empty array when no outcomes exist for the action", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const tracker = new OutcomeTracker(tmpDir, config);

      const results = await tracker.getOutcomesForAction("nonexistent");
      expect(results).toEqual([]);
    });
  });
});
