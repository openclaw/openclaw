/**
 * Security defaults — auto-inject skill-guard configuration on first run.
 *
 * Follows the same pattern as applyPluginAutoEnable(): detect missing config,
 * merge defaults, return the updated config + change descriptions.
 *
 * Called during gateway startup, right after applyPluginAutoEnable().
 */

import type { OpenClawConfig } from "./types.openclaw.js";
import type { SkillGuardConfig, SkillStoreConfig } from "./types.skills.js";

/** Default trusted store endpoint (update for production releases). */
export const DEFAULT_TRUSTED_STORE: SkillStoreConfig = {
  name: "OpenClaw Official Store",
  url: "https://privacy.lenovo.com.cn/skills/api/v1/skill-guard",
};

/** Default skill-guard configuration for first-run scenarios. */
export const DEFAULT_GUARD_CONFIG: SkillGuardConfig = {
  enabled: true,
  trustedStores: [DEFAULT_TRUSTED_STORE],
  sideloadPolicy: "block-critical",
  syncIntervalSeconds: 300,
  auditLog: true,
};

export type SecurityDefaultsResult = {
  config: OpenClawConfig;
  changes: string[];
};

/**
 * Inspect the current config and inject security defaults where missing.
 *
 * Rules:
 * - If skills.guard section is absent, inject full defaults.
 * - If skills.guard exists but trustedStores is empty, inject default store.
 * - If plugins.entries.skill-guard is absent, add { enabled: true }.
 * - If any of those keys already exist, leave them alone (respect user intent).
 */
export function applySecurityDefaults(params: { config: OpenClawConfig }): SecurityDefaultsResult {
  let next = params.config;
  const changes: string[] = [];

  // 1. Ensure skills.guard section exists
  const guard = next.skills?.guard;
  if (!guard) {
    next = {
      ...next,
      skills: {
        ...next.skills,
        guard: { ...DEFAULT_GUARD_CONFIG },
      },
    };
    changes.push(
      "skill-guard: injected default security config" +
        " (store: " +
        DEFAULT_TRUSTED_STORE.url +
        ", policy: block-critical)",
    );
  } else if (!guard.trustedStores || guard.trustedStores.length === 0) {
    next = {
      ...next,
      skills: {
        ...next.skills,
        guard: {
          ...next.skills?.guard,
          trustedStores: [DEFAULT_TRUSTED_STORE],
        },
      },
    };
    changes.push("skill-guard: added default trusted store (" + DEFAULT_TRUSTED_STORE.url + ")");
  }

  // 2. Ensure plugin entry is enabled
  // Only inject if entry is completely absent (respect explicit enabled:false).
  const entry = next.plugins?.entries?.["skill-guard"];
  if (!entry) {
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        entries: {
          ...next.plugins?.entries,
          "skill-guard": { enabled: true },
        },
      },
    };
    changes.push("skill-guard: auto-enabled plugin entry");
  }

  return { config: next, changes };
}
