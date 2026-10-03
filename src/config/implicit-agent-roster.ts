import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Materialize fresh-install defaults without interpreting persisted legacy rosters. */
export function applyImplicitAgentRosterDefaults(raw: unknown): unknown {
  if (!isRecord(raw) || (raw.agents !== undefined && !isRecord(raw.agents))) {
    return raw;
  }
  const agents = isRecord(raw.agents) ? raw.agents : {};
  if (
    agents.ownership === "explicit" ||
    (Object.hasOwn(agents, "list") && (!Array.isArray(agents.list) || agents.list.length > 0)) ||
    (agents.entries !== undefined &&
      (!isRecord(agents.entries) || Object.keys(agents.entries).length > 0))
  ) {
    return raw;
  }
  const { list: _emptyList, ...defaults } = agents;
  return { ...raw, agents: { ...defaults, entries: { main: {} } } };
}
