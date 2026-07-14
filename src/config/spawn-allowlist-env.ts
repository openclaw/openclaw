import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "./types.openclaw.js";

/**
 * Parses `OPENCLAW_SPAWN_ALLOWLIST` or `SPAWN_ALLOWLIST` for Docker deployments (#79490).
 * When set, applies to `agents.defaults.subagents.allowAgents` unless already configured on disk —
 * callers should only invoke the overlay path when JSON did not specify `allowAgents`.
 */
export function resolveSpawnAllowlistFromProcessEnv(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw =
    normalizeOptionalString(env.OPENCLAW_SPAWN_ALLOWLIST) ??
    normalizeOptionalString(env.SPAWN_ALLOWLIST);
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "*") {
    return ["*"];
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const ids = parsed
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean);
        return ids.length > 0 ? ids : undefined;
      }
    } catch {
      // Fall through to comma-separated parsing for mis-quoted JSON-ish values.
    }
  }
  const split = trimmed
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return split.length > 0 ? split : undefined;
}

export function applySpawnAllowlistEnvOverlay(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): void {
  const fromEnv = resolveSpawnAllowlistFromProcessEnv(env);
  if (!fromEnv) {
    return;
  }
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.subagents ??= {};
  cfg.agents.defaults.subagents.allowAgents = fromEnv;
}
