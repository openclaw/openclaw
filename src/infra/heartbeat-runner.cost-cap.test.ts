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
});
