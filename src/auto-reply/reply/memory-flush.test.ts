import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import {
  estimatePromptTokensForMemoryFlush,
  readPromptTokensFromSessionLog,
  resolveEffectivePromptTokens,
} from "./agent-runner-memory.js";
import { resolveSessionTranscriptPath } from "../../config/sessions.js";

describe("memory flush settings", () => {
  it("defaults to enabled with fallback prompt and system prompt", () => {
    const settings = resolveMemoryFlushSettings();
    expect(settings).not.toBeNull();
    expect(settings?.enabled).toBe(true);
    expect(settings?.prompt.length).toBeGreaterThan(0);
    expect(settings?.systemPrompt.length).toBeGreaterThan(0);
  });

  it("respects disable flag", () => {
    expect(
      resolveMemoryFlushSettings({
        agents: {
          defaults: { compaction: { memoryFlush: { enabled: false } } },
        },
      }),
    ).toBeNull();
  });

  it("appends NO_REPLY hint when missing", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              prompt: "Write memories now.",
              systemPrompt: "Flush memory.",
            },
          },
        },
      },
    });
    expect(settings?.prompt).toContain("NO_REPLY");
    expect(settings?.systemPrompt).toContain("NO_REPLY");
  });
});

describe("shouldRunMemoryFlush", () => {
  it("requires totalTokens and threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 0 },
        contextWindowTokens: 16_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when entry is missing", () => {
    expect(
      shouldRunMemoryFlush({
        entry: undefined,
        contextWindowTokens: 16_000,
        reserveTokensFloor: 1_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when totalTokens is undefined in entry", () => {
    // This is the most common failure mode: sessionEntry exists but totalTokens was never set
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: undefined },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 4_000,
      }),
    ).toBe(false);
  });

  it("skips when totalTokens is null in entry", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: null as unknown as number | undefined },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 4_000,
      }),
    ).toBe(false);
  });

  it("skips when totalTokens is negative", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: -1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 4_000,
      }),
    ).toBe(false);
  });

  it("skips when under threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 10_000 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 10_000,
      }),
    ).toBe(false);
  });

  it("triggers at the threshold boundary", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 85 },
        contextWindowTokens: 100,
        reserveTokensFloor: 10,
        softThresholdTokens: 5,
      }),
    ).toBe(true);
  });

  it("skips when already flushed for current compaction count", () => {
    expect(
      shouldRunMemoryFlush({
        entry: {
          totalTokens: 90_000,
          compactionCount: 2,
          memoryFlushCompactionCount: 2,
        },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });

  it("runs when above threshold and not flushed", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 96_000, compactionCount: 1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(true);
  });
});

describe("memory flush prompt estimates", () => {
  it("returns undefined for blank prompt text", () => {
    expect(estimatePromptTokensForMemoryFlush("   ")).toBeUndefined();
  });

  it("returns a positive integer estimate for prompt text", () => {
    const estimate = estimatePromptTokensForMemoryFlush("Hello memory flush.");
    expect(estimate).toBeTypeOf("number");
    expect(estimate).toBeGreaterThan(0);
    expect(Number.isInteger(estimate)).toBe(true);
  });

  it("adds the estimate to the larger of stored and transcript totals", () => {
    expect(
      resolveEffectivePromptTokens({
        baseTotalTokens: 120,
        transcriptTotalTokens: 200,
        promptTokenEstimate: 30,
      }),
    ).toBe(230);
  });
});

describe("memory flush transcript fallback", () => {
  it("uses the latest usage entry from the session transcript", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const logPath = path.join(tmp, "session.jsonl");
    const lines = [
      JSON.stringify({ message: { usage: { input: 10, output: 5 } } }),
      JSON.stringify({ usage: { total: 25 } }),
      JSON.stringify({ usage: { input: 3, cacheRead: 2, cacheWrite: 1, output: 4 } }),
    ];
    await fs.writeFile(logPath, lines.join("\n"), "utf-8");

    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: logPath,
    };
    const total = await readPromptTokensFromSessionLog("session", sessionEntry);

    expect(total).toBe(10);
  });

  it("derives the agent transcript path when sessionFile is missing", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-agent-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmp;
    try {
      const agentId = "alpha";
      const sessionId = "session";
      const logPath = resolveSessionTranscriptPath(sessionId, agentId);
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, JSON.stringify({ usage: { total: 12 } }), "utf-8");

      const sessionEntry = {
        sessionId,
        updatedAt: Date.now(),
      };
      const total = await readPromptTokensFromSessionLog(
        sessionId,
        sessionEntry,
        `agent:${agentId}:main`,
      );

      expect(total).toBe(12);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });
});

describe("resolveMemoryFlushContextWindowTokens", () => {
  it("falls back to agent config or default tokens", () => {
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 42_000 })).toBe(42_000);
  });
});
