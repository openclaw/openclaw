import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  featureFlagsForMode,
  getDefaultConfig,
  getDefaultFeatureFlags,
  loadConfig,
  mergeConfig,
  readModeFromEnv,
  resolveAgentConfig,
  saveConfig,
} from "./config.js";
import type { PolicyFeedbackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-config-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getDefaultConfig", () => {
  it("returns passive mode by default", () => {
    const config = getDefaultConfig();
    expect(config.mode).toBe("passive");
  });

  it("sets sensible defaults", () => {
    const config = getDefaultConfig();
    expect(config.aggregateIntervalMs).toBe(3_600_000);
    expect(config.outcomeHorizons).toEqual([60_000, 1_800_000, 86_400_000]);
    expect(config.constraints).toEqual([]);
    expect(config.logRetentionDays).toBe(90);
    expect(config.perAgentScoping).toBe(true);
  });
});

describe("getDefaultFeatureFlags", () => {
  it("enables all flags", () => {
    const flags = getDefaultFeatureFlags();
    expect(flags.enableActionLogging).toBe(true);
    expect(flags.enableOutcomeLogging).toBe(true);
    expect(flags.enableRanking).toBe(true);
    expect(flags.enableConstraints).toBe(true);
  });
});

describe("featureFlagsForMode", () => {
  it("disables everything in off mode", () => {
    const flags = featureFlagsForMode("off");
    expect(flags.enableActionLogging).toBe(false);
    expect(flags.enableOutcomeLogging).toBe(false);
    expect(flags.enableRanking).toBe(false);
    expect(flags.enableConstraints).toBe(false);
  });

  it("enables everything in passive mode", () => {
    const flags = featureFlagsForMode("passive");
    expect(flags.enableActionLogging).toBe(true);
    expect(flags.enableRanking).toBe(true);
  });

  it("enables everything in advisory mode", () => {
    const flags = featureFlagsForMode("advisory");
    expect(flags.enableActionLogging).toBe(true);
    expect(flags.enableConstraints).toBe(true);
  });

  it("enables everything in active mode", () => {
    const flags = featureFlagsForMode("active");
    expect(flags.enableActionLogging).toBe(true);
    expect(flags.enableOutcomeLogging).toBe(true);
  });
});

describe("readModeFromEnv", () => {
  it("returns undefined when env var is not set", () => {
    expect(readModeFromEnv({})).toBeUndefined();
  });

  it("reads valid mode values", () => {
    expect(readModeFromEnv({ OPENCLAW_POLICY_FEEDBACK_MODE: "off" })).toBe("off");
    expect(readModeFromEnv({ OPENCLAW_POLICY_FEEDBACK_MODE: "passive" })).toBe("passive");
    expect(readModeFromEnv({ OPENCLAW_POLICY_FEEDBACK_MODE: "advisory" })).toBe("advisory");
    expect(readModeFromEnv({ OPENCLAW_POLICY_FEEDBACK_MODE: "active" })).toBe("active");
  });

  it("handles case insensitivity and whitespace", () => {
    expect(readModeFromEnv({ OPENCLAW_POLICY_FEEDBACK_MODE: "  PASSIVE  " })).toBe("passive");
    expect(readModeFromEnv({ OPENCLAW_POLICY_FEEDBACK_MODE: "Active" })).toBe("active");
  });

  it("returns undefined for invalid values", () => {
    expect(readModeFromEnv({ OPENCLAW_POLICY_FEEDBACK_MODE: "turbo" })).toBeUndefined();
    expect(readModeFromEnv({ OPENCLAW_POLICY_FEEDBACK_MODE: "" })).toBeUndefined();
  });
});

describe("mergeConfig", () => {
  it("returns base when overrides are empty", () => {
    const base = getDefaultConfig();
    const merged = mergeConfig(base, {});
    expect(merged).toEqual(base);
  });

  it("overrides specified fields", () => {
    const base = getDefaultConfig();
    const merged = mergeConfig(base, { mode: "active", logRetentionDays: 30 });
    expect(merged.mode).toBe("active");
    expect(merged.logRetentionDays).toBe(30);
    // Non-overridden fields preserved
    expect(merged.aggregateIntervalMs).toBe(3_600_000);
  });

  it("does not clobber base values with undefined overrides", () => {
    const base = getDefaultConfig();
    const merged = mergeConfig(base, { mode: undefined } as Partial<PolicyFeedbackConfig>);
    expect(merged.mode).toBe("passive");
  });

  it("replaces arrays entirely", () => {
    const base = getDefaultConfig();
    const merged = mergeConfig(base, { outcomeHorizons: [5000] });
    expect(merged.outcomeHorizons).toEqual([5000]);
  });
});

describe("resolveAgentConfig", () => {
  it("returns base config when no agent overrides exist", () => {
    const base = getDefaultConfig();
    const resolved = resolveAgentConfig(base, "unknown-agent");
    expect(resolved).toEqual(base);
  });

  it("merges agent-specific overrides", () => {
    const base: PolicyFeedbackConfig = {
      ...getDefaultConfig(),
      agentOverrides: {
        "agent-a": { mode: "advisory", logRetentionDays: 7 },
      },
    };
    const resolved = resolveAgentConfig(base, "agent-a");
    expect(resolved.mode).toBe("advisory");
    expect(resolved.logRetentionDays).toBe(7);
    expect(resolved.aggregateIntervalMs).toBe(3_600_000);
  });
});

describe("loadConfig", () => {
  it("returns defaults when no persisted config exists", async () => {
    const config = await loadConfig({ home: tmpDir, env: {} });
    expect(config).toEqual(getDefaultConfig());
  });

  it("merges persisted config with defaults", async () => {
    const persisted: PolicyFeedbackConfig = {
      ...getDefaultConfig(),
      mode: "advisory",
      logRetentionDays: 14,
    };
    await saveConfig(persisted, { home: tmpDir });

    const config = await loadConfig({ home: tmpDir, env: {} });
    expect(config.mode).toBe("advisory");
    expect(config.logRetentionDays).toBe(14);
  });

  it("env var overrides persisted mode", async () => {
    const persisted: PolicyFeedbackConfig = {
      ...getDefaultConfig(),
      mode: "advisory",
    };
    await saveConfig(persisted, { home: tmpDir });

    const config = await loadConfig({
      home: tmpDir,
      env: { OPENCLAW_POLICY_FEEDBACK_MODE: "off" },
    });
    expect(config.mode).toBe("off");
    // Other fields still from persisted
    expect(config.aggregateIntervalMs).toBe(3_600_000);
  });

  it("env var overrides default mode", async () => {
    const config = await loadConfig({
      home: tmpDir,
      env: { OPENCLAW_POLICY_FEEDBACK_MODE: "active" },
    });
    expect(config.mode).toBe("active");
  });
});

describe("saveConfig", () => {
  it("persists config to disk and can be re-loaded", async () => {
    const config: PolicyFeedbackConfig = {
      ...getDefaultConfig(),
      mode: "active",
      logRetentionDays: 7,
    };
    await saveConfig(config, { home: tmpDir });

    const loaded = await loadConfig({ home: tmpDir, env: {} });
    expect(loaded.mode).toBe("active");
    expect(loaded.logRetentionDays).toBe(7);
  });
});
