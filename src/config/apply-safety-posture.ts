/**
 * Runtime expansion of safety posture presets into concrete config fields.
 *
 * Presets provide opinionated defaults; explicit config values always win.
 */

import type {
  SafetyPosturePreset,
  AgentToolProfile,
} from "./types.safety-posture.js";
import {
  SANDBOX_PRESETS,
  SESSION_PRESETS,
  MEMORY_PRESETS,
} from "./types.safety-posture.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const DEFAULT_AGENT_PROFILE: Record<SafetyPosturePreset, AgentToolProfile> = {
  development: "full",
  balanced: "limited",
  strict: "public",
};

/**
 * Apply safety posture preset to config.
 *
 * Explicit config values take precedence over preset defaults.
 * Returns a new config object (shallow-merges at affected paths).
 */
export function applySafetyPosture(cfg: OpenClawConfig): OpenClawConfig {
  const preset = cfg.safetyPosture?.preset;
  if (!preset) {
    return cfg;
  }

  const sandboxPreset = SANDBOX_PRESETS[preset];
  const sessionPreset = SESSION_PRESETS[preset];
  const memoryPreset = MEMORY_PRESETS[preset];

  // Build next config
  let next = cfg;

  // Sandbox mode — only apply if not explicitly set
  const agentDefaults = next.agents?.defaults;
  if (agentDefaults?.sandbox?.mode === undefined) {
    next = setDeep(next, ["agents", "defaults", "sandbox", "mode"], sandboxPreset.mode);
  }
  if (agentDefaults?.sandbox?.workspaceAccess === undefined) {
    next = setDeep(next, ["agents", "defaults", "sandbox", "workspaceAccess"], sandboxPreset.workspaceAccess);
  }

  // Session dmScope — only apply if not explicitly set
  if (next.session?.dmScope === undefined) {
    next = setDeep(next, ["session", "dmScope"], sessionPreset.dmScope);
  }

  // Memory long-term enabled — store as memory.qmd.sessions.enabled or similar.
  // Since there's no direct longTermMemoryEnabled field, we skip this mapping
  // unless the config gains one. The preset data is available for consumers
  // that check MEMORY_PRESETS directly.
  // TODO: Wire when config gains an explicit longTermMemoryEnabled field.

  // Agent tool profile
  if (cfg.safetyPosture?.agentProfile === undefined) {
    next = setDeep(next, ["_safetyPostureResolvedProfile"], DEFAULT_AGENT_PROFILE[preset]);
  } else {
    next = setDeep(next, ["_safetyPostureResolvedProfile"], cfg.safetyPosture.agentProfile);
  }

  return next;
}

/**
 * Type-safe deep set. Returns a new object with the path set to value.
 * Only creates new intermediate objects; does not mutate the input.
 */
function setDeep<T>(obj: T, path: string[], value: unknown): T {
  if (path.length === 0) return obj;
  const [head, ...rest] = path;
  const current = (obj as Record<string, unknown>)[head];
  if (rest.length === 0) {
    if (current === value) return obj;
    return { ...obj, [head]: value };
  }
  const nested = setDeep(current ?? {}, rest, value);
  if (current !== undefined && nested === current) return obj;
  return { ...obj, [head]: nested };
}
