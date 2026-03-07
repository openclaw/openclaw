import type { ChannelDirectoryEntry } from "./types.js";

function resolveDirectoryQuery(query?: string | null): string {
  return query?.trim().toLowerCase() || "";
}

function resolveDirectoryLimit(limit?: number | null): number | undefined {
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

function applyDirectoryQueryAndLimit(
  ids: string[],
  params: { query?: string | null; limit?: number | null },
): string[] {
  const q = resolveDirectoryQuery(params.query);
  const limit = resolveDirectoryLimit(params.limit);
  const filtered = ids.filter((id) => (q ? id.toLowerCase().includes(q) : true));
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function toDirectoryEntries(kind: "user" | "group", ids: string[]): ChannelDirectoryEntry[] {
  return ids.map((id) => ({ kind, id }) as const);
}

export function listDirectoryUserEntriesFromAllowFrom(params: {
  allowFrom?: readonly unknown[];
  query?: string | null;
  limit?: number | null;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = Array.from(
    new Set(
      (params.allowFrom ?? [])
        .map((entry) => String(entry).trim())
        .filter((entry) => Boolean(entry) && entry !== "*")
        .map((entry) => {
          const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
          return typeof normalized === "string" ? normalized.trim() : "";
        })
        .filter(Boolean),
    ),
  );
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export function listDirectoryGroupEntriesFromMapKeys(params: {
  groups?: Record<string, unknown>;
  query?: string | null;
  limit?: number | null;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = Array.from(
    new Set(
      Object.keys(params.groups ?? {})
        .map((entry) => entry.trim())
        .filter((entry) => Boolean(entry) && entry !== "*")
        .map((entry) => {
          const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
          return typeof normalized === "string" ? normalized.trim() : "";
        })
        .filter(Boolean),
    ),
  );
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}
