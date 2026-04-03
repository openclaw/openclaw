import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { estimateRunCost, runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

// ---------------------------------------------------------------------------
// Unit tests: estimateRunCost
// ---------------------------------------------------------------------------

describe("estimateRunCost", () => {
  it("estimates cost for a known model", () => {
    // 4000 chars = ~1000 tokens. claude-opus-4 = $15/M input tokens = $0.015/1K
    const cost = estimateRunCost("x".repeat(4000), "claude-opus-4-20260901");
    expect(cost).toBeCloseTo(0.015, 3);
  });

  it("estimates cost for a cheap model", () => {
    // 4000 chars = ~1000 tokens. gemini-2.0-flash = $0.10/M = $0.0001/1K
    const cost = estimateRunCost("x".repeat(4000), "gemini-2.0-flash");
    expect(cost).toBeCloseTo(0.0001, 5);
  });

  it("uses conservative fallback for unknown models", () => {
    const cost = estimateRunCost("x".repeat(4000), "some-unknown-model-v9");
    expect(cost).toBeCloseTo(0.015, 3);
  });

  it("returns zero for empty prompt", () => {
    const cost = estimateRunCost("", "claude-opus-4");
    expect(cost).toBe(0);
  });

  it("returns non-zero for single-char prompt", () => {
    // ceil(1/4) = 1 token
    const cost = estimateRunCost("a", "claude-opus-4");
    expect(cost).toBe(15 / 1_000_000);
  });

  it("handles large context (128K chars)", () => {
    // 128000 chars = ~32000 tokens. claude-opus-4 = $15/M = $0.48
    const cost = estimateRunCost("x".repeat(128_000), "claude-opus-4");
    expect(cost).toBeCloseTo(0.48, 2);
  });

  it("is case-insensitive for model names", () => {
    const lower = estimateRunCost("x".repeat(4000), "claude-opus-4");
    const upper = estimateRunCost("x".repeat(4000), "CLAUDE-OPUS-4");
    const mixed = estimateRunCost("x".repeat(4000), "Claude-Opus-4");
    expect(lower).toBe(upper);
    expect(lower).toBe(mixed);
  });
});

describe("prefix matching ordering", () => {
  it("gpt-4o matches gpt-4o pricing, not gpt-4", () => {
    const cost4o = estimateRunCost("x".repeat(4000), "gpt-4o-2026-03-01");
    const cost4 = estimateRunCost("x".repeat(4000), "gpt-4-0613");
    expect(cost4o).toBeLessThan(cost4);
    expect(cost4o).toBeCloseTo(0.0025, 4);
  });

  it("gpt-4-turbo matches gpt-4-turbo pricing, not gpt-4", () => {
    const costTurbo = estimateRunCost("x".repeat(4000), "gpt-4-turbo-preview");
    const cost4 = estimateRunCost("x".repeat(4000), "gpt-4-0613");
    expect(costTurbo).toBeLessThan(cost4);
    expect(costTurbo).toBeCloseTo(0.01, 4);
  });

  it("gpt-4 exact matches gpt-4 pricing", () => {
    const cost = estimateRunCost("x".repeat(4000), "gpt-4-0613");
    expect(cost).toBeCloseTo(0.03, 4);
  });

  it("o1-mini matches o1-mini pricing, not o1", () => {
    const costMini = estimateRunCost("x".repeat(4000), "o1-mini-2026-01-01");
    const costFull = estimateRunCost("x".repeat(4000), "o1-2026-01-01");
    expect(costMini).toBeLessThan(costFull);
    expect(costMini).toBeCloseTo(0.003, 4);
  });

  it("o3-mini matches o3-mini pricing, not o3", () => {
    const costMini = estimateRunCost("x".repeat(4000), "o3-mini");
    const costFull = estimateRunCost("x".repeat(4000), "o3-preview");
    expect(costMini).toBeLessThan(costFull);
    expect(costMini).toBeCloseTo(0.0011, 4);
  });
});

describe("config catalog lookup", () => {
  it("uses catalog pricing when model is defined in config", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            models: [
              {
                id: "my-cheap-model",
                cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as import("../config/config.js").OpenClawConfig;
    // 4000 chars = 1000 tokens. catalog says $0.50/M = $0.0005/1K
    const cost = estimateRunCost("x".repeat(4000), "custom/my-cheap-model", cfg);
    expect(cost).toBeCloseTo(0.0005, 5);
  });

  it("falls back to hardcoded table when model not in catalog", () => {
    const cfg = {
      models: { providers: {} },
    } as unknown as import("../config/config.js").OpenClawConfig;
    const cost = estimateRunCost("x".repeat(4000), "claude-opus-4", cfg);
    // Should still use hardcoded table: $15/M = $0.015/1K
    expect(cost).toBeCloseTo(0.015, 3);
  });

  it("falls back to hardcoded table when cfg is undefined", () => {
    const cost = estimateRunCost("x".repeat(4000), "claude-opus-4");
    expect(cost).toBeCloseTo(0.015, 3);
  });

  it("falls back to hardcoded table for bare model name without provider/", () => {
    const cfg = {
      models: {
        providers: {
          anthropic: {
            models: [
              {
                id: "claude-opus-4",
                cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as import("../config/config.js").OpenClawConfig;
    // Bare name "claude-opus-4" has no provider/ prefix, so parseModelRef
    // returns provider="" which fails catalog lookup. Falls back to hardcoded.
    const cost = estimateRunCost("x".repeat(4000), "claude-opus-4", cfg);
    expect(cost).toBeCloseTo(0.015, 3);
  });

  it("uses zero cost.input from catalog for free models", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            models: [
              {
                id: "free-model",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as import("../config/config.js").OpenClawConfig;
    const cost = estimateRunCost("x".repeat(4000), "custom/free-model", cfg);
    expect(cost).toBe(0); // free model = $0
  });

  it("uses zero cost.input from catalog (free/local model)", () => {
    const cfg = {
      models: {
        providers: {
          local: {
            models: [
              {
                id: "llama3",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as import("../config/config.js").OpenClawConfig;
    const cost = estimateRunCost("x".repeat(4000), "local/llama3", cfg);
    expect(cost).toBe(0); // free model = $0
  });

  it("matches hardcoded table with provider-prefixed model name", () => {
    // "openai/gpt-4o" should strip "openai/" and match "gpt-4o" in hardcoded table
    const cost = estimateRunCost("x".repeat(4000), "openai/gpt-4o");
    expect(cost).toBeCloseTo(0.0025, 4); // gpt-4o = $2.5/M
  });

  it("matches hardcoded table with nested provider prefix", () => {
    // "openrouter/anthropic/claude-opus-4" should strip to "claude-opus-4"
    const cost = estimateRunCost("x".repeat(4000), "openrouter/anthropic/claude-opus-4");
    expect(cost).toBeCloseTo(0.015, 3); // claude-opus-4 = $15/M
  });

  it("ignores catalog entry with negative cost.input", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            models: [
              {
                id: "bad-model",
                cost: { input: -5, output: 1, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as import("../config/config.js").OpenClawConfig;
    const cost = estimateRunCost("x".repeat(4000), "custom/bad-model", cfg);
    expect(cost).toBeCloseTo(0.015, 3); // fallback
  });
});

// ---------------------------------------------------------------------------
// Integration tests: runHeartbeatOnce with maxCostPerRun
// ---------------------------------------------------------------------------

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – maxCostPerRun", () => {
  async function runWithCostCap(params: { maxCostPerRun?: number; model?: string }) {
    return withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "whatsapp",
                model: params.model ?? "claude-opus-4",
                maxCostPerRun: params.maxCostPerRun,
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = resolveMainSessionKey(cfg);
        await seedSessionStore(storePath, sessionKey, {
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "+1555",
        });

        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        const result = await runHeartbeatOnce({
          cfg,
          deps: { getQueueSize: () => 0, nowMs: () => 0 },
        });

        // Capture spy state before withTempHeartbeatSandbox restores it in finally.
        const replyCallCount = replySpy.mock.calls.length;
        return { result, replyCallCount };
      },
      { prefix: "openclaw-hb-costcap-" },
    );
  }

  it("skips run when estimated cost exceeds maxCostPerRun", async () => {
    const { result, replyCallCount } = await runWithCostCap({ maxCostPerRun: 0.0000001 });
    expect(result).toEqual({ status: "skipped", reason: "cost-cap-exceeded" });
    expect(replyCallCount).toBe(0);
  });

  it("proceeds when estimated cost is within maxCostPerRun", async () => {
    const { result, replyCallCount } = await runWithCostCap({ maxCostPerRun: 100 });
    expect(result).toEqual(expect.objectContaining({ status: "ran" }));
    expect(replyCallCount).toBe(1);
  });

  it("proceeds when maxCostPerRun is not set", async () => {
    const { result, replyCallCount } = await runWithCostCap({ maxCostPerRun: undefined });
    expect(result).toEqual(expect.objectContaining({ status: "ran" }));
    expect(replyCallCount).toBe(1);
  });

  it("skips all runs when maxCostPerRun is 0", async () => {
    const { result, replyCallCount } = await runWithCostCap({ maxCostPerRun: 0 });
    expect(result).toEqual({ status: "skipped", reason: "cost-cap-exceeded" });
    expect(replyCallCount).toBe(0);
  });

  it("ignores negative maxCostPerRun (no cap)", async () => {
    const { result, replyCallCount } = await runWithCostCap({ maxCostPerRun: -1 });
    expect(result).toEqual(expect.objectContaining({ status: "ran" }));
    expect(replyCallCount).toBe(1);
  });

  it("ignores NaN maxCostPerRun (no cap)", async () => {
    const { result, replyCallCount } = await runWithCostCap({ maxCostPerRun: NaN });
    expect(result).toEqual(expect.objectContaining({ status: "ran" }));
    expect(replyCallCount).toBe(1);
  });

  it("ignores Infinity maxCostPerRun (no cap)", async () => {
    const { result, replyCallCount } = await runWithCostCap({ maxCostPerRun: Infinity });
    expect(result).toEqual(expect.objectContaining({ status: "ran" }));
    expect(replyCallCount).toBe(1);
  });

  it("skips cheap (non-free) model when maxCostPerRun is 0", async () => {
    // gemini-2.0-flash costs $0.10/M input — non-zero — so with maxCostPerRun = 0
    // the condition (estimatedCost > 0) is true and the run is skipped.
    // Note: a *truly* free model (cost.input = 0 in catalog) would NOT be skipped
    // because 0 > 0 === false. That scenario is covered by the unit tests above.
    const { result, replyCallCount } = await runWithCostCap({
      maxCostPerRun: 0,
      model: "gemini-2.0-flash", // cheapest in table, but still > $0 for non-empty prompt
    });
    // gemini-2.0-flash with HEARTBEAT.md context will have cost > 0, so it gets skipped
    expect(result).toEqual({ status: "skipped", reason: "cost-cap-exceeded" });
    expect(replyCallCount).toBe(0);
  });
});
