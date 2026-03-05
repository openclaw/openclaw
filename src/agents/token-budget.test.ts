import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isBudgetExhausted,
  loadBudgetState,
  recordBudgetUsage,
  resolveActiveTier,
  resolveBudgetDate,
  resetIfNewDay,
  saveBudgetState,
  tierKey,
} from "./token-budget.js";
import type { TokenBudgetConfig, TokenBudgetState, TokenBudgetTier } from "./token-budget.types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-budget-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tierKey", () => {
  it("joins provider and model with /", () => {
    expect(tierKey("openai", "gpt-5.1-codex")).toBe("openai/gpt-5.1-codex");
  });
});

describe("resolveBudgetDate", () => {
  it("returns a YYYY-MM-DD string for local time", () => {
    const date = resolveBudgetDate("midnight-local");
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a YYYY-MM-DD string for UTC time", () => {
    const date = resolveBudgetDate("midnight-utc");
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("defaults to local time when undefined", () => {
    const date = resolveBudgetDate(undefined);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("loadBudgetState", () => {
  it("returns empty state when file does not exist", () => {
    const state = loadBudgetState("midnight-local", tmpDir);
    expect(state.version).toBe(1);
    expect(state.usage.tiers).toEqual({});
    expect(state.usage.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("loads persisted state for today", () => {
    const today = resolveBudgetDate("midnight-local");
    const persisted: TokenBudgetState = {
      version: 1,
      usage: {
        date: today,
        tiers: { "openai/gpt-5.1-codex": 500_000 },
      },
    };
    const filePath = path.join(tmpDir, "token-budget.json");
    fs.writeFileSync(filePath, JSON.stringify(persisted), "utf8");

    const state = loadBudgetState("midnight-local", tmpDir);
    expect(state.usage.tiers["openai/gpt-5.1-codex"]).toBe(500_000);
  });

  it("resets state when date is stale", () => {
    const persisted: TokenBudgetState = {
      version: 1,
      usage: {
        date: "2020-01-01",
        tiers: { "openai/gpt-5.1-codex": 999_999 },
      },
    };
    const filePath = path.join(tmpDir, "token-budget.json");
    fs.writeFileSync(filePath, JSON.stringify(persisted), "utf8");

    const state = loadBudgetState("midnight-local", tmpDir);
    expect(state.usage.tiers).toEqual({});
  });

  it("resets state when version is wrong", () => {
    const filePath = path.join(tmpDir, "token-budget.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 99, usage: { date: "2020-01-01", tiers: {} } }),
      "utf8",
    );

    const state = loadBudgetState("midnight-local", tmpDir);
    expect(state.version).toBe(1);
    expect(state.usage.tiers).toEqual({});
  });

  it("handles malformed JSON gracefully", () => {
    const filePath = path.join(tmpDir, "token-budget.json");
    fs.writeFileSync(filePath, "not json", "utf8");

    const state = loadBudgetState("midnight-local", tmpDir);
    expect(state.version).toBe(1);
  });
});

describe("saveBudgetState", () => {
  it("persists state to disk", () => {
    const today = resolveBudgetDate("midnight-local");
    const state: TokenBudgetState = {
      version: 1,
      usage: {
        date: today,
        tiers: { "openai/gpt-5.1-codex": 123_456 },
      },
    };

    saveBudgetState(state, tmpDir);

    const filePath = path.join(tmpDir, "token-budget.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(loaded.usage.tiers["openai/gpt-5.1-codex"]).toBe(123_456);
  });
});

describe("isBudgetExhausted", () => {
  const tier: TokenBudgetTier = {
    provider: "openai",
    model: "gpt-5.1-codex",
    dailyTokenLimit: 1_000_000,
  };

  it("returns false when under limit", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: { "openai/gpt-5.1-codex": 500_000 } },
    };
    expect(isBudgetExhausted(state, tier)).toBe(false);
  });

  it("returns true when at limit", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: { "openai/gpt-5.1-codex": 1_000_000 } },
    };
    expect(isBudgetExhausted(state, tier)).toBe(true);
  });

  it("returns true when over limit", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: { "openai/gpt-5.1-codex": 1_500_000 } },
    };
    expect(isBudgetExhausted(state, tier)).toBe(true);
  });

  it("returns false when tier has no recorded usage", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: {} },
    };
    expect(isBudgetExhausted(state, tier)).toBe(false);
  });
});

describe("recordBudgetUsage", () => {
  it("accumulates tokens for a tier", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: { "openai/gpt-5.1-codex": 100_000 } },
    };
    recordBudgetUsage(state, "openai", "gpt-5.1-codex", 50_000);
    expect(state.usage.tiers["openai/gpt-5.1-codex"]).toBe(150_000);
  });

  it("initializes usage for a new tier", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: {} },
    };
    recordBudgetUsage(state, "openai", "gpt-5.1-codex-mini", 25_000);
    expect(state.usage.tiers["openai/gpt-5.1-codex-mini"]).toBe(25_000);
  });

  it("ignores zero or negative tokens", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: { "openai/gpt-5.1-codex": 100 } },
    };
    recordBudgetUsage(state, "openai", "gpt-5.1-codex", 0);
    recordBudgetUsage(state, "openai", "gpt-5.1-codex", -50);
    expect(state.usage.tiers["openai/gpt-5.1-codex"]).toBe(100);
  });
});

describe("resolveActiveTier", () => {
  const config: TokenBudgetConfig = {
    enabled: true,
    tiers: [
      { provider: "openai", model: "gpt-5.1-codex", dailyTokenLimit: 1_000_000 },
      { provider: "openai", model: "gpt-5.1-codex-mini", dailyTokenLimit: 10_000_000 },
    ],
  };

  it("returns first tier when no usage", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: {} },
    };
    const tier = resolveActiveTier(config, state);
    expect(tier?.model).toBe("gpt-5.1-codex");
  });

  it("returns second tier when first is exhausted", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2026-03-03", tiers: { "openai/gpt-5.1-codex": 1_000_000 } },
    };
    const tier = resolveActiveTier(config, state);
    expect(tier?.model).toBe("gpt-5.1-codex-mini");
  });

  it("returns null when all tiers exhausted", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: {
        date: "2026-03-03",
        tiers: {
          "openai/gpt-5.1-codex": 1_000_000,
          "openai/gpt-5.1-codex-mini": 10_000_000,
        },
      },
    };
    const tier = resolveActiveTier(config, state);
    expect(tier).toBeNull();
  });
});

describe("resetIfNewDay", () => {
  it("returns state unchanged when date matches", () => {
    const today = resolveBudgetDate("midnight-local");
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: today, tiers: { "openai/gpt-5.1-codex": 42 } },
    };
    const result = resetIfNewDay(state, "midnight-local");
    expect(result.usage.tiers["openai/gpt-5.1-codex"]).toBe(42);
  });

  it("resets counters when date is stale", () => {
    const state: TokenBudgetState = {
      version: 1,
      usage: { date: "2020-01-01", tiers: { "openai/gpt-5.1-codex": 999_999 } },
    };
    const result = resetIfNewDay(state, "midnight-local");
    expect(result.usage.tiers).toEqual({});
    expect(result.usage.date).not.toBe("2020-01-01");
  });
});
