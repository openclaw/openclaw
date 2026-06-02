import { isVitestRuntimeEnv } from "../infra/env.js";

const LEGACY_ENV_PREFIXES = ["CLAWDBOT_", "MOLTBOT_"] as const;
type LegacyEnvPrefix = (typeof LEGACY_ENV_PREFIXES)[number];

let warned = false;

/**
 * Warn once when legacy Clawdbot/Moltbot env names are present.
 *
 * Gateway config no longer reads those names; this warning catches stale shell
 * or launchd environments without printing the variable values.
 */
export function warnLegacyOpenClawEnvVars(env: NodeJS.ProcessEnv = process.env): void {
  if (warned || isVitestRuntimeEnv(env)) {
    return;
  }

  const prefixCounts = new Map<LegacyEnvPrefix, number>();
  for (const key of Object.keys(env)) {
    const prefix = LEGACY_ENV_PREFIXES.find((candidate) => key.startsWith(candidate));
    if (prefix) {
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }

  const legacyVarCount = [...prefixCounts.values()].reduce((total, count) => total + count, 0);
  if (legacyVarCount === 0) {
    return;
  }

  const detectedPrefixes = LEGACY_ENV_PREFIXES.filter((prefix) => prefixCounts.has(prefix))
    .map((prefix) => `${prefix}*`)
    .join(", ");

  process.emitWarning(
    [
      `Legacy ${detectedPrefixes} environment variables were detected (${legacyVarCount} total), but OpenClaw only reads OPENCLAW_* names now.`,
      "Rename them by replacing the legacy prefix with OPENCLAW_; the old names are ignored.",
    ].join("\n"),
    { code: "OPENCLAW_LEGACY_ENV_VARS", type: "DeprecationWarning" },
  );
  warned = true;
}

/** Reset the process-local warning latch for focused tests. */
export function resetLegacyOpenClawEnvWarningForTest(): void {
  warned = false;
}
