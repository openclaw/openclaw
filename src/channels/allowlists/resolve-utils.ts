import type { RuntimeEnv } from "../../runtime.js";

export type AllowlistUserResolutionLike = {
  input: string;
  resolved: boolean;
  id?: string;
};

export function mergeAllowlist(params: {
  existing?: Array<string | number>;
  additions: string[];
}): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  const push = (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(normalized);
  };
  for (const entry of params.existing ?? []) {
    push(String(entry));
  }
  for (const entry of params.additions) {
    push(entry);
  }
  return merged;
}

export function buildAllowlistResolutionSummary<T extends AllowlistUserResolutionLike>(
  resolvedUsers: T[],
): {
  resolvedMap: Map<string, T>;
  mapping: string[];
  unresolved: string[];
} {
  const resolvedMap = new Map(resolvedUsers.map((entry) => [entry.input, entry]));
  const mapping = resolvedUsers
    .filter((entry) => entry.resolved && entry.id)
    .map((entry) => `${entry.input}→${entry.id}`);
  const unresolved = resolvedUsers.filter((entry) => !entry.resolved).map((entry) => entry.input);
  return { resolvedMap, mapping, unresolved };
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
