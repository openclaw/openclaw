import type { RuntimeEnv } from "../../runtime.js";

export type AllowlistUserResolutionLike = {
  input: string;
  resolved: boolean;
  id?: string;
};

function dedupeAllowlistEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of entries) {
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

export function mergeAllowlist(params: {
  existing?: Array<string | number>;
  additions: string[];
}): string[] {
  return dedupeAllowlistEntries([
    ...(params.existing ?? []).map((entry) => String(entry)),
    ...params.additions,
  ]);
}

export function buildAllowlistResolutionSummary<T extends AllowlistUserResolutionLike>(
  resolvedUsers: T[],
  opts?: { formatResolved?: (entry: T) => string },
): {
  resolvedMap: Map<string, T>;
  mapping: string[];
  unresolved: string[];
  additions: string[];
} {
  const resolvedMap = new Map(resolvedUsers.map((entry) => [entry.input, entry]));
  const resolvedOk = (entry: T) => Boolean(entry.resolved && entry.id);
  const formatResolved = opts?.formatResolved ?? ((entry: T) => `${entry.input}→${entry.id}`);
  const mapping = resolvedUsers.filter(resolvedOk).map(formatResolved);
  const additions = resolvedUsers
    .filter(resolvedOk)
    .map((entry) => entry.id)
    .filter((entry): entry is string => Boolean(entry));
  const unresolved = resolvedUsers
    .filter((entry) => !resolvedOk(entry))
    .map((entry) => entry.input);
  return { resolvedMap, mapping, unresolved, additions };
}

export function resolveAllowlistIdAdditions<T extends AllowlistUserResolutionLike>(params: {
  existing: Array<string | number>;
  resolvedMap: Map<string, T>;
}): string[] {
  const additions: string[] = [];
  for (const entry of params.existing) {
    const trimmed = String(entry).trim();
    const resolved = params.resolvedMap.get(trimmed);
    if (resolved?.resolved && resolved.id) {
      additions.push(resolved.id);
    }
  }
  return additions;
}

export function canonicalizeAllowlistWithResolvedIds<
  T extends AllowlistUserResolutionLike,
>(params: { existing?: Array<string | number>; resolvedMap: Map<string, T> }): string[] {
  const canonicalized: string[] = [];
  for (const entry of params.existing ?? []) {
    const trimmed = String(entry).trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      canonicalized.push(trimmed);
      continue;
    }
    const resolved = params.resolvedMap.get(trimmed);
    canonicalized.push(resolved?.resolved && resolved.id ? resolved.id : trimmed);
  }
  return dedupeAllowlistEntries(canonicalized);
}

export function patchAllowlistUsersInConfigEntries<
  T extends AllowlistUserResolutionLike,
  TEntries extends Record<string, unknown>,
>(params: {
  entries: TEntries;
  resolvedMap: Map<string, T>;
  strategy?: "merge" | "canonicalize";
}): TEntries {
  const nextEntries: Record<string, unknown> = { ...params.entries };
  for (const [entryKey, entryConfig] of Object.entries(params.entries)) {
    if (!entryConfig || typeof entryConfig !== "object") {
      continue;
    }
    const users = (entryConfig as { users?: Array<string | number> }).users;
    if (!Array.isArray(users) || users.length === 0) {
      continue;
    }
    const additions = resolveAllowlistIdAdditions({
      existing: users,
      resolvedMap: params.resolvedMap,
    });
    const resolvedUsers =
      params.strategy === "canonicalize"
        ? canonicalizeAllowlistWithResolvedIds({
            existing: users,
            resolvedMap: params.resolvedMap,
          })
        : mergeAllowlist({ existing: users, additions });
    nextEntries[entryKey] = {
      ...entryConfig,
      users: resolvedUsers,
    };
  }
  return nextEntries as TEntries;
}

export function addAllowlistUserEntriesFromConfigEntry(target: Set<string>, entry: unknown): void {
  if (!entry || typeof entry !== "object") {
    return;
  }
  const users = (entry as { users?: Array<string | number> }).users;
  if (!Array.isArray(users)) {
    return;
  }
  for (const value of users) {
    const trimmed = String(value).trim();
    if (trimmed && trimmed !== "*") {
      target.add(trimmed);
    }
  }
}

export function summarizeMapping(
  label: string,
  mapping: string[],
  unresolved: string[],
  runtime: RuntimeEnv,
): void {
  const lines: string[] = [];
  if (mapping.length > 0) {
    const sample = mapping.slice(0, 6);
    const suffix = mapping.length > sample.length ? ` (+${mapping.length - sample.length})` : "";
    lines.push(`${label} resolved: ${sample.join(", ")}${suffix}`);
  }
  if (unresolved.length > 0) {
    const sample = unresolved.slice(0, 6);
    const suffix =
      unresolved.length > sample.length ? ` (+${unresolved.length - sample.length})` : "";
    lines.push(`${label} unresolved: ${sample.join(", ")}${suffix}`);
  }
  if (lines.length > 0) {
    runtime.log?.(lines.join("\n"));
  }
}
