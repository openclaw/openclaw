const LEGACY_ENV_PREFIXES = ["CLAWDBOT_", "MOLTBOT_"] as const;

let warned = false;

export function warnLegacyOpenClawEnvVars(env: NodeJS.ProcessEnv = process.env): void {
  if (warned || process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return;
  }

  const legacyVars = Object.keys(env)
    .flatMap((key) => {
      const prefix = LEGACY_ENV_PREFIXES.find((candidate) => key.startsWith(candidate));
      if (!prefix) {
        return [];
      }
      return [{ legacy: key, replacement: `OPENCLAW_${key.slice(prefix.length)}` }];
    })
    .toSorted((left, right) => left.legacy.localeCompare(right.legacy));

  if (legacyVars.length === 0) {
    return;
  }

  process.emitWarning(
    [
      "Legacy CLAWDBOT_* or MOLTBOT_* environment variables were detected, but OpenClaw only reads OPENCLAW_* names now.",
      ...legacyVars.map(({ legacy, replacement }) => `${legacy} -> ${replacement}`),
    ].join("\n"),
    { code: "OPENCLAW_LEGACY_ENV_VARS", type: "DeprecationWarning" },
  );
  warned = true;
}

export function resetLegacyOpenClawEnvWarningForTest(): void {
  warned = false;
}
