export type ContextAlertLevel = 0 | 85 | 95;

export type ContextAlertDecision = {
  nextLevel: ContextAlertLevel;
  shouldAlert: boolean;
  alertLevel: Exclude<ContextAlertLevel, 0> | null;
};

export function evaluateContextAlert(params: {
  usedTokens: number | undefined;
  contextTokens: number | undefined;
  previousLevel?: ContextAlertLevel;
  previousAt?: number;
  now?: number;
  cooldownMs?: number;
}): ContextAlertDecision {
  const used = params.usedTokens;
  const limit = params.contextTokens;
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used <= 0 ||
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return { nextLevel: 0, shouldAlert: false, alertLevel: null };
  }

  const ratio = used / limit;
  const previousLevel = params.previousLevel ?? 0;
  const previousAt = params.previousAt;
  const now = params.now ?? Date.now();
  const cooldownMs = params.cooldownMs ?? 30 * 60 * 1000;

  let nextLevel: ContextAlertLevel = 0;
  if (ratio >= 0.95) {
    nextLevel = 95;
  } else if (ratio >= 0.85) {
    nextLevel = 85;
  }

  // Hysteresis to prevent noisy oscillation around thresholds.
  if (previousLevel === 95 && ratio >= 0.92 && nextLevel < 95) {
    nextLevel = 95;
  }
  if (previousLevel >= 85 && ratio >= 0.82 && nextLevel < 85) {
    nextLevel = 85;
  }

  const crossedUp = nextLevel > previousLevel;
  const cooledDown =
    typeof previousAt !== "number" ||
    !Number.isFinite(previousAt) ||
    now - previousAt >= cooldownMs;

  if (crossedUp && cooledDown && nextLevel > 0) {
    const alertLevel: Exclude<ContextAlertLevel, 0> = nextLevel === 95 ? 95 : 85;
    return {
      nextLevel,
      shouldAlert: true,
      alertLevel,
    };
  }

  return {
    nextLevel,
    shouldAlert: false,
    alertLevel: null,
  };
}

function formatK(n: number): string {
  if (!Number.isFinite(n)) {
    return "?";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}k`;
  }
  return String(Math.round(n));
}

export function buildContextAlertMessage(params: {
  level: Exclude<ContextAlertLevel, 0>;
  usedTokens: number;
  contextTokens: number;
}): string {
  const pct = Math.min(
    999,
    Math.max(0, Math.round((params.usedTokens / params.contextTokens) * 100)),
  );
  const usage = `${formatK(params.usedTokens)}/${formatK(params.contextTokens)}`;
  if (params.level >= 95) {
    return `⚠️ Context warning: ${pct}% (${usage}) used. Next turn may overflow. Consider /compact now.`;
  }
  return `⚠️ Context warning: ${pct}% (${usage}) used. Consider /compact to keep this session stable.`;
}
