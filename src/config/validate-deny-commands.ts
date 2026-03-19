import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  resolveNodeCommandAllowlist,
} from "../gateway/node-command-policy.js";
import type { OpenClawConfig } from "./config.js";

export interface DenyCommandValidationResult {
  valid: boolean;
  errors: string[];
}

export function collectAllKnownNodeCommands(cfg: OpenClawConfig): Set<string> {
  // This validator runs before full schema validation, so malformed allowCommands
  // must not crash known-command collection.
  const rawAllowCommands = cfg.gateway?.nodes?.allowCommands;
  const safeAllowCommands = Array.isArray(rawAllowCommands)
    ? rawAllowCommands.filter((value): value is string => typeof value === "string")
    : [];
  const baseCfg: OpenClawConfig = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      nodes: {
        ...cfg.gateway?.nodes,
        allowCommands: safeAllowCommands,
        denyCommands: [],
      },
    },
  };

  const out = new Set<string>();
  for (const platform of ["ios", "android", "macos", "linux", "windows", "unknown"] as const) {
    const allowlist = resolveNodeCommandAllowlist(baseCfg, { platform });
    for (const command of allowlist) {
      const trimmed = command.trim();
      if (trimmed) {
        out.add(trimmed);
      }
    }
  }
  for (const command of DEFAULT_DANGEROUS_NODE_COMMANDS) {
    out.add(command);
  }
  return out;
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );

  for (let i = 0; i <= a.length; i += 1) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[a.length][b.length];
}

function suggestClosest(entry: string, known: Set<string>, maxDistance = 3): string | null {
  const needle = entry.toLowerCase();
  const namespace = needle.split(".")[0] ?? "";
  let best: string | null = null;
  let bestDistance = maxDistance;
  let bestSharesNamespace = false;

  for (const command of known) {
    const candidate = command.toLowerCase();
    const distance = editDistance(needle, candidate);
    if (distance > bestDistance) {
      continue;
    }
    const sharesNamespace = namespace !== "" && candidate.startsWith(`${namespace}.`);
    if (
      distance < bestDistance ||
      (distance === bestDistance && sharesNamespace && !bestSharesNamespace)
    ) {
      best = command;
      bestDistance = distance;
      bestSharesNamespace = sharesNamespace;
    }
  }

  return best;
}

export function looksLikeCommandPattern(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.startsWith("group:")) {
    return true;
  }
  if (value.includes("*") || value.includes("?")) {
    return true;
  }
  if (value.includes("[") && value.includes("]")) {
    return true;
  }
  return /^\/.+\/[a-z]*$/i.test(value);
}

export function validateDenyCommandEntries(
  entries: unknown,
  cfg: OpenClawConfig,
): DenyCommandValidationResult {
  if (!Array.isArray(entries)) {
    return { valid: true, errors: [] };
  }

  const known = collectAllKnownNodeCommands(cfg);
  const errors: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    if (looksLikeCommandPattern(trimmed)) {
      errors.push(
        `"${trimmed}" looks like a pattern, but denyCommands uses exact matching only. Use exact command names instead.`,
      );
      continue;
    }

    if (!known.has(trimmed)) {
      const suggestion = suggestClosest(trimmed, known);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
      const namespace = trimmed.split(".")[0] ?? "";
      const namespaceMatches = namespace
        ? Array.from(known).filter((command) => command.startsWith(`${namespace}.`))
        : [];
      const examples = (namespaceMatches.length > 0 ? namespaceMatches : Array.from(known))
        .slice(0, 5)
        .join(", ");
      errors.push(
        `Unknown command "${trimmed}" in denyCommands.${hint} Known commands include: ${examples}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
