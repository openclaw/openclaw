import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { __test } from "./usage.js";

const { loadCostUsageSummaryCached, costUsageCache } = __test;

describe("usage.cost multi-agent (#20558)", () => {
  let root: string;
  let originalState: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cost-multi-agent-"));
    originalState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    costUsageCache.clear();
  });

  afterEach(() => {
    if (originalState === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalState;
    }
  });

  it("includes tokens from non-main agents in cost summary", async () => {
    const ts = new Date().toISOString();

    const mainDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(mainDir, { recursive: true });
    await fs.writeFile(
      path.join(mainDir, "sess-main.jsonl"),
      JSON.stringify({
        type: "message",
        timestamp: ts,
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.10 } },
        },
      }),
      "utf-8",
    );

    const workerDir = path.join(root, "agents", "worker", "sessions");
    await fs.mkdir(workerDir, { recursive: true });
    await fs.writeFile(
      path.join(workerDir, "sess-worker.jsonl"),
      JSON.stringify({
        type: "message",
        timestamp: ts,
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: { input: 200, output: 100, totalTokens: 300, cost: { total: 0.20 } },
        },
      }),
      "utf-8",
    );

    const startMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const endMs = Date.now() + 24 * 60 * 60 * 1000;
    const config = {} as OpenClawConfig;

    const summary = await loadCostUsageSummaryCached({ startMs, endMs, config });

    expect(summary.totals.totalTokens).toBe(450);
    expect(summary.totals.totalCost).toBeCloseTo(0.30, 5);
  });

  it("merges daily entries from multiple agents on the same date", async () => {
    const ts = new Date().toISOString();

    for (const [agentId, tokens] of [["main", 100], ["alpha", 200], ["beta", 300]] as const) {
      const dir = path.join(root, "agents", agentId, "sessions");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `sess-${agentId}.jsonl`),
        JSON.stringify({
          type: "message",
          timestamp: ts,
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5.2",
            usage: { input: tokens, output: 0, totalTokens: tokens, cost: { total: tokens * 0.001 } },
          },
        }),
        "utf-8",
      );
    }

    const startMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const endMs = Date.now() + 24 * 60 * 60 * 1000;
    const config = {} as OpenClawConfig;

    const summary = await loadCostUsageSummaryCached({ startMs, endMs, config });

    expect(summary.totals.totalTokens).toBe(600);
    expect(summary.totals.totalCost).toBeCloseTo(0.60, 5);
    // All three agents report on the same day → single daily entry
    expect(summary.daily).toHaveLength(1);
    expect(summary.daily[0]?.totalTokens).toBe(600);
  });
});
