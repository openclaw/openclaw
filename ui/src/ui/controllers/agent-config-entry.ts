export type AgentConfigEditPlan = {
  index: number;
  initializeList: boolean;
  initializeEntry: boolean;
};

type ConfigWithAgentsList = {
  agents?: {
    list?: unknown;
  };
};

function resolveAgentIndex(list: unknown[], agentId: string): number {
  return list.findIndex(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      "id" in entry &&
      (entry as { id?: string }).id === agentId,
  );
}

/**
 * Resolve where a per-agent config edit should be written.
 *
 * On fresh installs, `agents.list` may be absent even though runtime reports
 * a `main` agent. In that case, callers can opt into creating list/entry
 * scaffolding before writing tool/model/skills overrides.
 */
export function planAgentConfigEntryEdit(
  configValue: Record<string, unknown> | null,
  agentId: string,
  createIfMissing: boolean,
): AgentConfigEditPlan | null {
  if (!configValue) {
    return null;
  }
  const list = (configValue as ConfigWithAgentsList).agents?.list;
  if (!Array.isArray(list)) {
    return createIfMissing ? { index: 0, initializeList: true, initializeEntry: false } : null;
  }
  const index = resolveAgentIndex(list, agentId);
  if (index >= 0) {
    return { index, initializeList: false, initializeEntry: false };
  }
  if (!createIfMissing) {
    return null;
  }
  return { index: list.length, initializeList: false, initializeEntry: true };
}
