import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";
import { expandHomePrefix } from "./home-dir.js";

export type FilesystemPermissionBits = `${"r" | "-"}${"w" | "-"}${"x" | "-"}`;
export type FilesystemPermissionOperation = "read" | "write" | "execute";

export type FilesystemPermissionsConfig = {
  rules?: Record<string, string>;
  deny?: string[];
  default?: string;
};

type ResolvedFilesystemPermissionRule = {
  pattern: string;
  bits: FilesystemPermissionBits;
  specificity: number;
  order: number;
};

export type ResolvedFilesystemPermissions = {
  rules: ResolvedFilesystemPermissionRule[];
  deny: string[];
  defaultBits: FilesystemPermissionBits;
};

type FilesystemPermissionMatch = {
  kind: "rule";
  pattern: string;
  bits: FilesystemPermissionBits;
};

type FilesystemPermissionDecision = {
  allowed: boolean;
  resolvedPath: string;
  requiredBit: "r" | "w" | "x";
  source: "deny" | "rule" | "default";
  sourcePattern?: string;
  effectiveBits: FilesystemPermissionBits;
};

const DEFAULT_FILESYSTEM_PERMISSIONS: FilesystemPermissionBits = "---";

function isValidFilesystemPermissionBits(value: string): value is FilesystemPermissionBits {
  return /^[-r][-w][-x]$/i.test(value);
}

export function normalizeFilesystemPermissionBits(
  value: string | undefined,
  fallback: FilesystemPermissionBits = DEFAULT_FILESYSTEM_PERMISSIONS,
): FilesystemPermissionBits {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !isValidFilesystemPermissionBits(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizePattern(pattern: string | undefined): string | null {
  const trimmed = pattern?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function normalizeDenyPatterns(deny: string[] | undefined): string[] | undefined {
  if (!Array.isArray(deny)) {
    return undefined;
  }
  const next = deny
    .map((entry) => normalizePattern(entry))
    .filter((entry): entry is string => Boolean(entry));
  return next.length > 0 ? next : undefined;
}

function normalizeRuleEntries(
  rules: Record<string, string> | undefined,
): Record<string, FilesystemPermissionBits> | undefined {
  if (!rules || typeof rules !== "object") {
    return undefined;
  }
  const entries = Object.entries(rules)
    .map(([rawPattern, rawBits]) => {
      const pattern = normalizePattern(rawPattern);
      if (!pattern) {
        return null;
      }
      return [pattern, normalizeFilesystemPermissionBits(rawBits)] as const;
    })
    .filter((entry): entry is readonly [string, FilesystemPermissionBits] => entry !== null);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

export function normalizeFilesystemPermissionsConfig(
  config: FilesystemPermissionsConfig | undefined,
): FilesystemPermissionsConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const rules = normalizeRuleEntries(config.rules);
  const deny = normalizeDenyPatterns(config.deny);
  const defaultBits = normalizeFilesystemPermissionBits(config.default);

  return {
    ...(rules ? { rules } : {}),
    ...(deny ? { deny } : {}),
    ...(defaultBits !== DEFAULT_FILESYSTEM_PERMISSIONS ? { default: defaultBits } : {}),
  };
}

function resolveRuleSpecificity(pattern: string): number {
  const expanded = pattern.startsWith("~") ? expandHomePrefix(pattern) : pattern;
  return expanded.length;
}

export function resolveFilesystemPermissions(
  config: FilesystemPermissionsConfig | undefined,
): ResolvedFilesystemPermissions | undefined {
  const normalized = normalizeFilesystemPermissionsConfig(config);
  if (!normalized) {
    return undefined;
  }

  const deny = normalizeDenyPatterns(normalized.deny) ?? [];
  const ruleEntries = Object.entries(normalized.rules ?? {});
  const rules: ResolvedFilesystemPermissionRule[] = [];
  for (let i = 0; i < ruleEntries.length; i += 1) {
    const [pattern, bits] = ruleEntries[i];
    rules.push({
      pattern,
      bits: normalizeFilesystemPermissionBits(bits),
      specificity: resolveRuleSpecificity(pattern),
      order: i,
    });
  }

  return {
    rules,
    deny,
    defaultBits: normalizeFilesystemPermissionBits(normalized.default),
  };
}

function resolveRequiredBit(operation: FilesystemPermissionOperation): {
  bit: "r" | "w" | "x";
  index: number;
} {
  if (operation === "read") {
    return { bit: "r", index: 0 };
  }
  if (operation === "write") {
    return { bit: "w", index: 1 };
  }
  return { bit: "x", index: 2 };
}

function normalizePathLikeToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("~")) {
    return expandHomePrefix(trimmed);
  }
  if (!/^file:\/\//i.test(trimmed)) {
    return trimmed;
  }
  try {
    return fileURLToPath(trimmed);
  } catch {
    return trimmed;
  }
}

export function resolveFilesystemPermissionPath(params: {
  targetPath: string;
  cwd?: string;
}): string {
  const normalized = normalizePathLikeToken(params.targetPath);
  const base = params.cwd && params.cwd.trim() ? params.cwd : process.cwd();
  const absolute = path.isAbsolute(normalized) ? normalized : path.resolve(base, normalized);
  return path.resolve(absolute);
}

function matchMostSpecificRule(params: {
  rules: ResolvedFilesystemPermissionRule[];
  resolvedPath: string;
}): FilesystemPermissionMatch | null {
  let best: ResolvedFilesystemPermissionRule | null = null;
  for (const rule of params.rules) {
    if (!matchesExecAllowlistPattern(rule.pattern, params.resolvedPath)) {
      continue;
    }
    if (
      !best ||
      rule.specificity > best.specificity ||
      (rule.specificity === best.specificity && rule.order > best.order)
    ) {
      best = rule;
    }
  }
  if (!best) {
    return null;
  }
  return {
    kind: "rule",
    pattern: best.pattern,
    bits: best.bits,
  };
}

export function evaluateFilesystemPathPermission(params: {
  permissions: ResolvedFilesystemPermissions;
  targetPath: string;
  operation: FilesystemPermissionOperation;
  cwd?: string;
}): FilesystemPermissionDecision {
  const resolvedPath = resolveFilesystemPermissionPath({
    targetPath: params.targetPath,
    cwd: params.cwd,
  });
  const { bit: requiredBit, index } = resolveRequiredBit(params.operation);

  for (const denyPattern of params.permissions.deny) {
    if (matchesExecAllowlistPattern(denyPattern, resolvedPath)) {
      return {
        allowed: false,
        resolvedPath,
        requiredBit,
        source: "deny",
        sourcePattern: denyPattern,
        effectiveBits: DEFAULT_FILESYSTEM_PERMISSIONS,
      };
    }
  }

  const match = matchMostSpecificRule({
    rules: params.permissions.rules,
    resolvedPath,
  });
  const effectiveBits = match?.bits ?? params.permissions.defaultBits;
  const allowed = effectiveBits[index] === requiredBit;
  return {
    allowed,
    resolvedPath,
    requiredBit,
    source: match ? "rule" : "default",
    sourcePattern: match?.pattern,
    effectiveBits,
  };
}

export function assertFilesystemPathPermission(params: {
  permissions: ResolvedFilesystemPermissions | undefined;
  targetPath: string;
  operation: FilesystemPermissionOperation;
  cwd?: string;
  context?: string;
}): void {
  if (!params.permissions) {
    return;
  }
  const decision = evaluateFilesystemPathPermission({
    permissions: params.permissions,
    targetPath: params.targetPath,
    operation: params.operation,
    cwd: params.cwd,
  });
  if (decision.allowed) {
    return;
  }
  const context = params.context ? `${params.context}: ` : "";
  const sourceText =
    decision.source === "deny"
      ? `deny pattern "${decision.sourcePattern ?? ""}"`
      : decision.source === "rule"
        ? `rule "${decision.sourcePattern ?? ""}" => "${decision.effectiveBits}"`
        : `default "${decision.effectiveBits}"`;
  throw new Error(
    `${context}filesystem permission denied (${decision.requiredBit}) for ${decision.resolvedPath} (${sourceText})`,
  );
}
