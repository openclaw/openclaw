/**
 * Powernap intent detection and diagnostics.
 *
 * Detects whether a powernap is:
 * - "deploy": post-deploy cleanup (skip diagnostics)
 * - "glitch": manual fix for misbehavior (run diagnostics)
 * - "clean": explicitly requested clean slate
 *
 * Intent detection uses process uptime: if the gateway was recently started
 * (< 5 minutes), it's likely a post-deploy nap. Otherwise, manual/glitch.
 */

import { logVerbose } from "../../globals.js";

export type PowernapIntent = "deploy" | "glitch" | "clean";

export type PowernapMode = "all" | "groups" | "stale" | "here";

/** Time threshold below which we consider this a post-deploy restart (5 minutes). */
const DEPLOY_UPTIME_THRESHOLD_S = 300;

/**
 * Auto-detect powernap intent based on gateway uptime.
 * If the gateway just started (< 5 min ago), this is likely a post-deploy cleanup.
 */
export function detectPowernapIntent(): PowernapIntent {
  const uptimeSeconds = process.uptime();
  if (uptimeSeconds < DEPLOY_UPTIME_THRESHOLD_S) {
    logVerbose(
      `powernap intent: deploy (gateway uptime ${Math.round(uptimeSeconds)}s < ${DEPLOY_UPTIME_THRESHOLD_S}s)`,
    );
    return "deploy";
  }
  logVerbose(
    `powernap intent: glitch (gateway uptime ${Math.round(uptimeSeconds)}s >= ${DEPLOY_UPTIME_THRESHOLD_S}s)`,
  );
  return "glitch";
}

export type PowernapArgs = {
  mode: PowernapMode;
  intent: PowernapIntent;
  isStats: boolean;
};

/**
 * Parse powernap command arguments.
 *
 * Supported args:
 * - (none) = auto-detect intent, reset all sessions
 * - "clean" = force clean intent (skip diagnostics), reset all
 * - "diagnose" = force glitch intent (run diagnostics), reset all
 * - "groups" = reset only group sessions
 * - "stale" = reset only sessions with high token usage or inactive > 24h
 * - "stats" = show powernap analytics (no reset)
 */
export function parsePowernapArgs(rawArgs?: string): PowernapArgs {
  const arg = rawArgs?.trim().toLowerCase();

  if (!arg) {
    return { mode: "all", intent: detectPowernapIntent(), isStats: false };
  }

  if (arg === "stats") {
    return { mode: "all", intent: "clean", isStats: true };
  }

  if (arg === "clean") {
    return { mode: "all", intent: "clean", isStats: false };
  }

  if (arg === "diagnose") {
    return { mode: "all", intent: "glitch", isStats: false };
  }

  if (arg === "groups") {
    return { mode: "groups", intent: detectPowernapIntent(), isStats: false };
  }

  if (arg === "stale") {
    return { mode: "stale", intent: detectPowernapIntent(), isStats: false };
  }

  // Unknown arg, treat as default
  return { mode: "all", intent: detectPowernapIntent(), isStats: false };
}

/** Token usage percentage threshold for "stale" mode. */
const STALE_TOKEN_THRESHOLD = 0.7;

/** Inactivity threshold for "stale" mode (24 hours). */
const STALE_INACTIVITY_MS = 24 * 60 * 60 * 1000;

/**
 * Determine if a session key should be reset based on the selected mode.
 */
export function shouldResetSession(
  key: string,
  mode: PowernapMode,
  entry?: {
    totalTokens?: number;
    contextTokens?: number;
    updatedAt?: number;
    chatType?: string;
  },
): boolean {
  // Never reset cron sessions regardless of mode
  if (key.includes(":cron:")) {
    return false;
  }

  switch (mode) {
    case "all":
      return true;

    case "groups":
      // Reset only group sessions (keys containing :group:)
      return key.includes(":group:");

    case "stale": {
      if (!entry) {
        return false;
      }
      const now = Date.now();
      // Reset if token usage is high
      if (
        entry.totalTokens &&
        entry.contextTokens &&
        entry.contextTokens > 0 &&
        entry.totalTokens / entry.contextTokens >= STALE_TOKEN_THRESHOLD
      ) {
        return true;
      }
      // Reset if inactive for > 24h
      if (entry.updatedAt && now - entry.updatedAt > STALE_INACTIVITY_MS) {
        return true;
      }
      return false;
    }

    case "here":
      // Single-session mode handled by /powernaphere, not here
      return false;

    default:
      return true;
  }
}
