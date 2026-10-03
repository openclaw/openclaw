import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentConfig, AgentEntryConfig, AgentsConfig } from "./types.agents.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Retired roster row; only Doctor, pre-admission migrations, and raw-input compatibility read it. */
export type LegacyAgentListEntry = AgentConfig & { default?: boolean };

/**
 * Persisted pre-Doctor config: canonical fields plus the retired `agents.list` roster and
 * `default` markers. Validation rejects both, so runtime config never has this shape.
 */
export type OpenClawConfigWithLegacyRoster = Omit<OpenClawConfig, "agents"> & {
  agents?: Omit<AgentsConfig, "entries"> & {
    entries?: Record<string, AgentEntryConfig & { default?: boolean }>;
    list?: LegacyAgentListEntry[];
  };
};

/** Keeps Doctor's allocated identities tied to their original authored list positions. */
export function projectLegacyAgentRosterEntries(list: unknown[]) {
  const entries: { sourceIndex: number; id: string; config: Record<string, unknown> }[] = [];
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  for (const [sourceIndex, value] of list.entries()) {
    if (!isRecord(value)) {
      diagnostics.push(`Removed malformed agents.list[${sourceIndex}] entry.`);
      continue;
    }
    const rawId = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "agent";
    const requestedId = normalizeAgentId(rawId);
    if (requestedId !== rawId) {
      diagnostics.push(`Normalized agents.list id "${rawId}" → agents.entries.${requestedId}.`);
    }
    let id = requestedId;
    let suffix = 2;
    while (ids.has(id)) {
      id = `${requestedId}-${suffix}`;
      suffix += 1;
    }
    const { id: _id, ...config } = value;
    entries.push({ sourceIndex, id, config });
    ids.add(id);
    if (id !== requestedId) {
      diagnostics.push(`Moved duplicate agents.list id "${requestedId}" to agents.entries.${id}.`);
    }
  }
  return { entries, diagnostics };
}

/** Converts a valid legacy roster without applying ownership or runtime migrations. */
export function parseLegacyAgentRoster(
  value: unknown,
): { entries: Record<string, Record<string, unknown>>; order: string[] } | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = new Set<string>();
  const entries: [string, Record<string, unknown>][] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const { id, ...config } = entry;
    if (typeof id !== "string" || id.trim() !== id || !id) {
      return undefined;
    }
    const normalizedId = normalizeAgentId(id);
    if (normalizedId !== id || ids.has(normalizedId)) {
      return undefined;
    }
    ids.add(id);
    entries.push([id, config]);
  }
  return { entries: Object.fromEntries(entries), order: [...ids] };
}

/** Resolve the original data owner using the same occurrence identities Doctor allocates. */
export function resolveLegacyAgentRosterOwner(raw: unknown): string | undefined {
  const agents = isRecord(raw) && isRecord(raw.agents) ? raw.agents : undefined;
  if (!agents || agents.ownership === "explicit") {
    return undefined;
  }
  const entries = Object.hasOwn(agents, "entries")
    ? isRecord(agents.entries)
      ? Object.entries(agents.entries).map(([id, config]) => ({ id, config }))
      : []
    : Array.isArray(agents.list)
      ? projectLegacyAgentRosterEntries(agents.list).entries
      : [];
  if (
    entries.length < 2 ||
    entries.some(
      ({ config }) =>
        !isRecord(config) ||
        (Object.hasOwn(config, "default") && typeof config.default !== "boolean"),
    )
  ) {
    return undefined;
  }
  const marked = entries.filter(({ config }) => isRecord(config) && config.default === true);
  return marked.length === 1 ? normalizeAgentId(marked[0]!.id) : undefined;
}
