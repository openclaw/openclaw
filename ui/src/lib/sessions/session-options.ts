import type { SessionsListResult } from "../../api/types.ts";
import { isCronSessionKey, resolveSessionDisplayName } from "../session-display.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import { getVisibleSessionRows } from "./index.ts";
import {
  buildAgentMainSessionKey,
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "./session-key.ts";

type SessionAgentOptionsState = {
  agentsList?: {
    defaultId?: string | null;
    agents?: Array<{
      id: string;
      name?: string | null;
      identity?: { name?: string | null } | null;
    }> | null;
  } | null;
  chatAgentSessionRowsByAgent?: Record<string, SessionsListResult["sessions"]>;
  sessionsHideCron?: boolean;
  sessionsResult?: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
  sessionKey: string;
};

export type SessionOptionGroup = {
  id: string;
  label: string;
  options: Array<{
    key: string;
    label: string;
    scopeLabel: string;
    title: string;
  }>;
};

export type SessionAgentFilterOption = {
  id: string;
  label: string;
};

export function resolveSessionAgentFilterId(
  state: SessionAgentOptionsState,
  sessionKey: string,
): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? state.agentsList?.defaultId ?? "main");
}

function resolvePreferredSessionCandidateAgentId(
  row: SessionsListResult["sessions"][number],
  defaultAgentId: string,
): string | null {
  if (row.kind === "global" || row.kind === "unknown" || isCronSessionKey(row.key)) {
    return null;
  }
  if (isSubagentSessionKey(row.key) || row.spawnedBy) {
    return null;
  }
  const parsed = parseAgentSessionKey(row.key);
  return normalizeAgentId(parsed?.agentId ?? defaultAgentId);
}

export function rememberSessionAgentRows(
  state: SessionAgentOptionsState,
  sessions: SessionsListResult | null,
): void {
  if (!sessions) {
    return;
  }
  const refreshedAgentId = normalizeOptionalString(state.sessionsResultAgentId);
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const grouped = new Map<string, SessionsListResult["sessions"]>();
  for (const row of sessions.sessions) {
    const agentId = resolvePreferredSessionCandidateAgentId(row, defaultAgentId);
    if (!agentId) {
      continue;
    }
    grouped.set(agentId, [...(grouped.get(agentId) ?? []), row]);
  }
  if (grouped.size === 0 && !refreshedAgentId) {
    return;
  }
  state.chatAgentSessionRowsByAgent ??= {};
  if (refreshedAgentId) {
    state.chatAgentSessionRowsByAgent[refreshedAgentId] = grouped.get(refreshedAgentId) ?? [];
  }
  for (const [agentId, agentRows] of grouped) {
    state.chatAgentSessionRowsByAgent[agentId] = agentRows;
  }
}

function rowsForPreferredAgentSession(
  state: SessionAgentOptionsState,
  normalizedAgentId: string,
  defaultAgentId: string,
): SessionsListResult["sessions"] {
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of state.chatAgentSessionRowsByAgent?.[normalizedAgentId] ?? []) {
    byKey.set(row.key, row);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    if (resolvePreferredSessionCandidateAgentId(row, defaultAgentId) === normalizedAgentId) {
      byKey.set(row.key, row);
    }
  }
  return [...byKey.values()];
}

export function resolvePreferredSessionForAgent(
  state: SessionAgentOptionsState,
  agentId: string,
): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (resolveSessionAgentFilterId(state, state.sessionKey) === normalizedAgentId) {
    return state.sessionKey;
  }
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const eligible = rowsForPreferredAgentSession(state, normalizedAgentId, defaultAgentId)
    .filter((row) => {
      if (!isSessionKeyTiedToAgent(row.key, normalizedAgentId, defaultAgentId)) {
        return false;
      }
      return resolvePreferredSessionCandidateAgentId(row, defaultAgentId) === normalizedAgentId;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (eligible[0]?.key) {
    return eligible[0].key;
  }
  return buildAgentMainSessionKey({ agentId: normalizedAgentId });
}

export function resolveSessionAgentFilterOptions(
  state: SessionAgentOptionsState,
): SessionAgentFilterOption[] {
  const seen = new Set<string>();
  const options: SessionAgentFilterOption[] = [];
  const add = (agentId: string) => {
    const normalized = normalizeAgentId(agentId);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    options.push({
      id: normalized,
      label: resolveAgentGroupLabel(state, normalized),
    });
  };

  add(resolveSessionAgentFilterId(state, state.sessionKey));
  add(state.agentsList?.defaultId ?? "main");
  for (const agent of state.agentsList?.agents ?? []) {
    add(agent.id);
  }
  for (const row of state.sessionsResult?.sessions ?? []) {
    const parsed = parseAgentSessionKey(row.key);
    if (parsed) {
      add(parsed.agentId);
    }
  }

  return options;
}

export function resolveSessionOptionGroups(
  state: SessionAgentOptionsState,
  sessionKey: string,
  sessions: SessionsListResult | null,
): SessionOptionGroup[] {
  const rows = sessions?.sessions ?? [];
  const hideCron = state.sessionsHideCron ?? true;
  const activeAgentId = resolveSessionAgentFilterId(state, sessionKey);
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of rows) {
    byKey.set(row.key, row);
  }

  const seenKeys = new Set<string>();
  const groups = new Map<string, SessionOptionGroup>();
  const ensureGroup = (groupId: string, label: string): SessionOptionGroup => {
    const existing = groups.get(groupId);
    if (existing) {
      return existing;
    }
    const created: SessionOptionGroup = {
      id: groupId,
      label,
      options: [],
    };
    groups.set(groupId, created);
    return created;
  };

  const addOption = (key: string) => {
    if (!key || seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    const row = byKey.get(key);
    const parsed = parseAgentSessionKey(key);
    const group = parsed
      ? ensureGroup(
          `agent:${normalizeLowercaseStringOrEmpty(parsed.agentId)}`,
          resolveAgentGroupLabel(state, parsed.agentId),
        )
      : ensureGroup("other", "Other Sessions");
    const scopeLabel = normalizeOptionalString(parsed?.rest) ?? key;
    group.options.push({
      key,
      label: resolveSessionScopedOptionLabel(key, row, parsed?.rest),
      scopeLabel,
      title: key,
    });
  };

  for (const row of getVisibleSessionRows(sessions, {
    currentSessionKey: sessionKey,
    agentId: activeAgentId,
    defaultAgentId,
    filterByAgent: true,
    hideCron,
  })) {
    addOption(row.key);
  }
  if (byKey.has(sessionKey)) {
    addOption(sessionKey);
  } else if (sessionKey) {
    addOption(sessionKey);
  }

  disambiguateSessionOptionLabels(groups);
  return Array.from(groups.values());
}

function disambiguateSessionOptionLabels(groups: Map<string, SessionOptionGroup>) {
  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const option of group.options) {
      counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    }
    for (const option of group.options) {
      if ((counts.get(option.label) ?? 0) > 1 && option.scopeLabel !== option.label) {
        option.label = `${option.label} · ${option.scopeLabel}`;
      }
    }
  }

  const allOptions = Array.from(groups.values()).flatMap((group) =>
    group.options.map((option) => ({ groupLabel: group.label, option })),
  );
  const labels = new Map(allOptions.map(({ option }) => [option, option.label]));
  const countAssignedLabels = () => {
    const counts = new Map<string, number>();
    for (const { option } of allOptions) {
      const label = labels.get(option) ?? option.label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  };
  const labelIncludesScopeLabel = (label: string, scopeLabel: string) => {
    const trimmedScope = scopeLabel.trim();
    if (!trimmedScope) {
      return false;
    }
    return (
      label === trimmedScope ||
      label.endsWith(` · ${trimmedScope}`) ||
      label.endsWith(` / ${trimmedScope}`)
    );
  };

  const globalCounts = countAssignedLabels();
  for (const { groupLabel, option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((globalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    const scopedPrefix = `${groupLabel} / `;
    if (currentLabel.startsWith(scopedPrefix)) {
      continue;
    }
    labels.set(option, `${groupLabel} / ${currentLabel}`);
  }

  const scopedCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((scopedCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    if (labelIncludesScopeLabel(currentLabel, option.scopeLabel)) {
      continue;
    }
    labels.set(option, `${currentLabel} · ${option.scopeLabel}`);
  }

  const finalCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((finalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    labels.set(option, `${currentLabel} · ${option.key}`);
  }

  for (const { option } of allOptions) {
    option.label = labels.get(option) ?? option.label;
  }
}

function resolveAgentGroupLabel(state: SessionAgentOptionsState, agentIdRaw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(agentIdRaw);
  const agent = (state.agentsList?.agents ?? []).find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === normalized,
  );
  const name =
    normalizeOptionalString(agent?.identity?.name) ?? normalizeOptionalString(agent?.name) ?? "";
  return name && name !== agentIdRaw ? `${name} (${agentIdRaw})` : agentIdRaw;
}

function resolveSessionScopedOptionLabel(
  key: string,
  row?: SessionsListResult["sessions"][number],
  rest?: string,
) {
  const base = normalizeOptionalString(rest) ?? key;
  if (!row) {
    return base;
  }

  const label = normalizeOptionalString(row.label) ?? "";
  const displayName = normalizeOptionalString(row.displayName) ?? "";
  if ((label && label !== key) || (displayName && displayName !== key)) {
    return resolveSessionDisplayName(key, row);
  }

  return base;
}
