import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config.js";
import { ActionLedger } from "./ledger.js";
import { readActions } from "./persistence.js";
import type { LogActionInput, PolicyFeedbackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInput(overrides?: Partial<LogActionInput>): LogActionInput {
  return {
    agentId: "agent-1",
    sessionKey: "session-abc",
    actionType: "agent_reply",
    channelId: "telegram",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-ledger-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ActionLedger", () => {
  describe("logAction", () => {
    it("creates an ActionRecord with a unique ID and persists it", async () => {
      const config = getDefaultConfig();
      const ledger = new ActionLedger(tmpDir, config);
      const input = makeInput();

      const record = await ledger.logAction(input);

      expect(record.id).toBeDefined();
      expect(typeof record.id).toBe("string");
      expect(record.id.length).toBeGreaterThan(0);
      expect(record.agentId).toBe("agent-1");
      expect(record.actionType).toBe("agent_reply");
      expect(record.channelId).toBe("telegram");
      expect(record.policyMode).toBe("passive");
      expect(record.timestamp).toBeDefined();

      // Verify persisted
      const stored = await readActions({ agentId: "agent-1", home: tmpDir });
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(record.id);
    });

    it("generates unique IDs for each action", async () => {
      const config = getDefaultConfig();
      const ledger = new ActionLedger(tmpDir, config);

      const r1 = await ledger.logAction(makeInput());
      const r2 = await ledger.logAction(makeInput());

      expect(r1.id).not.toBe(r2.id);
    });

    it("includes optional fields when provided", async () => {
      const config = getDefaultConfig();
      const ledger = new ActionLedger(tmpDir, config);

      const record = await ledger.logAction(
        makeInput({
          sessionId: "sess-uuid-1",
          accountId: "acct-1",
          contextSummary: "User asked about weather",
          toolName: "weather-tool",
          rationale: "User question requires weather data",
          metadata: { tokens: 150 },
        }),
      );

      expect(record.sessionId).toBe("sess-uuid-1");
      expect(record.accountId).toBe("acct-1");
      expect(record.contextSummary).toBe("User asked about weather");
      expect(record.toolName).toBe("weather-tool");
      expect(record.rationale).toBe("User question requires weather data");
      expect(record.metadata).toEqual({ tokens: 150 });
    });

    it("is a no-op when enableActionLogging is false (mode=off)", async () => {
      const config: PolicyFeedbackConfig = { ...getDefaultConfig(), mode: "off" };
      const ledger = new ActionLedger(tmpDir, config);

      const record = await ledger.logAction(makeInput());

      // Still returns a record (for caller convenience)
      expect(record.id).toBeDefined();
      expect(record.agentId).toBe("agent-1");

      // But nothing persisted
      const stored = await readActions({ home: tmpDir });
      expect(stored).toHaveLength(0);
      const agentStored = await readActions({ agentId: "agent-1", home: tmpDir });
      expect(agentStored).toHaveLength(0);
    });

    it("never throws on persistence error", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        // Use perAgentScoping: false so it writes globally
        perAgentScoping: false,
      };
      const ledger = new ActionLedger(tmpDir, config);

      // Make the storage dir unwritable by pointing to a file instead of dir
      const blockerPath = path.join(tmpDir, ".openclaw", "policy-feedback", "actions.jsonl");
      await fs.mkdir(path.dirname(blockerPath), { recursive: true });
      // Create a directory where the file should be, causing an EISDIR error
      await fs.mkdir(blockerPath, { recursive: true });

      // Should not throw, returns a record (error is logged via subsystem logger)
      const record = await ledger.logAction(makeInput());
      expect(record.id).toBeDefined();
    });

    it("writes to global log when perAgentScoping is false", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const ledger = new ActionLedger(tmpDir, config);

      await ledger.logAction(makeInput());

      const globalActions = await readActions({ home: tmpDir });
      expect(globalActions).toHaveLength(1);

      const agentActions = await readActions({ agentId: "agent-1", home: tmpDir });
      expect(agentActions).toHaveLength(0);
    });
  });

  describe("queryActions", () => {
    it("returns all actions for a user", async () => {
      const config = getDefaultConfig();
      const ledger = new ActionLedger(tmpDir, config);

      await ledger.logAction(makeInput({ agentId: "agent-1" }));
      await ledger.logAction(makeInput({ agentId: "agent-1" }));

      const results = await ledger.queryActions({ userId: "agent-1" });
      expect(results).toHaveLength(2);
    });

    it("filters by since timestamp", async () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        perAgentScoping: false,
      };
      const ledger = new ActionLedger(tmpDir, config);

      await ledger.logAction(makeInput());
      // Small delay to ensure different timestamps
      const cutoff = Date.now();
      await ledger.logAction(makeInput());

      const results = await ledger.queryActions({ since: cutoff });
      expect(results).toHaveLength(1);
    });

    it("respects limit parameter", async () => {
      const config = getDefaultConfig();
      const ledger = new ActionLedger(tmpDir, config);

      await ledger.logAction(makeInput({ agentId: "agent-1" }));
      await ledger.logAction(makeInput({ agentId: "agent-1" }));
      await ledger.logAction(makeInput({ agentId: "agent-1" }));

      const results = await ledger.queryActions({ userId: "agent-1", limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("returns empty array on error", async () => {
      const config = getDefaultConfig();
      const ledger = new ActionLedger(tmpDir, config);

      // Point to a nonexistent deep path — readActions returns [] for ENOENT
      const results = await ledger.queryActions({ userId: "nonexistent" });
      expect(results).toEqual([]);
    });
  });

  describe("getRecentActions", () => {
    it("returns recent actions for a user with default limit", async () => {
      const config = getDefaultConfig();
      const ledger = new ActionLedger(tmpDir, config);

      await ledger.logAction(makeInput({ agentId: "agent-1" }));

      const results = await ledger.getRecentActions("agent-1");
      expect(results).toHaveLength(1);
    });

    it("respects custom limit", async () => {
      const config = getDefaultConfig();
      const ledger = new ActionLedger(tmpDir, config);

      for (let i = 0; i < 5; i++) {
        await ledger.logAction(makeInput({ agentId: "agent-1" }));
      }

      const results = await ledger.getRecentActions("agent-1", 3);
      expect(results).toHaveLength(3);
    });
  });
});
