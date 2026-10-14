import type { SessionToolOverrides } from "./patch.ts";

type BooleanOverrideGroup = "mcpServers" | "skills";

export function readOwnEntry<T>(
  values: Readonly<Record<string, T>> | null | undefined,
  name: string,
): T | undefined {
  return values != null && Object.hasOwn(values, name) ? values[name] : undefined;
}

export function resolveToolOverrideState(baseEnabled: boolean, override: boolean | undefined) {
  return override ?? baseEnabled;
}

/**
 * Effective web-search state for the session capability toggle.
 * Global `tools.web.search.enabled: false` is a kill switch: a session
 * `webSearch: true` override cannot re-enable search.
 */
export function resolveWebSearchToolOverrideState(
  baseEnabled: boolean,
  override: boolean | undefined,
) {
  return baseEnabled && (override ?? baseEnabled);
}

export function nextBooleanToolOverrides(
  current: SessionToolOverrides | null | undefined,
  group: BooleanOverrideGroup,
  name: string,
  nextEnabled: boolean,
  baseEnabled: boolean,
): SessionToolOverrides {
  const next = { ...current };
  const values = { ...(Object.hasOwn(next, group) ? next[group] : undefined), [name]: nextEnabled };
  if (nextEnabled === baseEnabled) {
    delete values[name];
  }
  if (Object.keys(values).length === 0) {
    delete next[group];
  } else {
    next[group] = values;
  }
  return next;
}

export function nextWebSearchToolOverrides(
  current: SessionToolOverrides | null | undefined,
  nextEnabled: boolean,
  baseEnabled = true,
): SessionToolOverrides {
  const next = { ...current };
  // Clear stale enablement without discarding an explicit session suppression.
  if (!baseEnabled) {
    if (next.webSearch === true) {
      delete next.webSearch;
    }
    return next;
  }
  if (nextEnabled === baseEnabled) {
    delete next.webSearch;
  } else {
    next.webSearch = nextEnabled;
  }
  return next;
}

export function nextMcpToolsDenyOverrides(
  current: SessionToolOverrides | null | undefined,
  server: string,
  rawToolName: string,
  denied: boolean,
): SessionToolOverrides {
  const next = { ...current };
  const currentDeny = Object.hasOwn(next, "mcpToolsDeny") ? next.mcpToolsDeny : undefined;
  const deniedTools = new Set(readOwnEntry(currentDeny, server) ?? []);
  if (denied) {
    deniedTools.add(rawToolName);
  } else {
    deniedTools.delete(rawToolName);
  }
  const mcpToolsDeny = { ...currentDeny, [server]: [...deniedTools].toSorted() };
  if (deniedTools.size === 0) {
    delete mcpToolsDeny[server];
  }
  if (Object.keys(mcpToolsDeny).length === 0) {
    delete next.mcpToolsDeny;
  } else {
    next.mcpToolsDeny = mcpToolsDeny;
  }
  return next;
}

export function countSessionToolOverrides(
  overrides: SessionToolOverrides | null | undefined,
): number {
  return (
    Object.keys(overrides?.mcpServers ?? {}).length +
    Object.keys(overrides?.skills ?? {}).length +
    Object.keys(overrides?.mcpToolsDeny ?? {}).length +
    (overrides?.webSearch !== undefined ? 1 : 0)
  );
}
