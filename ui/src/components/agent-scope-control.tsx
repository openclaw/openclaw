import { createMemo, Show } from "solid-js";
import type { GatewayAgentRow } from "../api/types.ts";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../lib/agents/display.ts";
import { t } from "../lib/reactive/i18n.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { AgentSelectOption } from "./agent-select.ts";
import "./agent-select-registration.ts";
import { icons } from "./icons.ts";

type AgentScopeControlProps = {
  agents: readonly GatewayAgentRow[];
  additionalAgentIds?: readonly string[];
  selection: AgentSelectionCapability;
  allowAll?: boolean;
  selectedId?: string | null;
};

export function AgentScopeControl(params: AgentScopeControlProps) {
  const selection = createMemo(() => {
    const requestedSelected = params.selectedId ?? params.selection.state.scopeId ?? "";
    const selectedId = requestedSelected ? normalizeAgentId(requestedSelected) : "";
    const allowAll = params.allowAll !== false;
    // Do not let historical or selected IDs reintroduce a typed system row.
    const isSystemAgentId = (agentId: string) =>
      params.agents.some(
        (agent) => agent.kind === "system" && normalizeAgentId(agent.id) === agentId,
      );
    const selectableAgents = listSelectableAgents(params.agents);
    if (selectableAgents.length <= 1) {
      return undefined;
    }
    const agentsById = new Map(
      selectableAgents.map((agent) => {
        const agentId = normalizeAgentId(agent.id);
        return [agentId, agentId === agent.id ? agent : { ...agent, id: agentId }] as const;
      }),
    );
    for (const value of params.additionalAgentIds ?? []) {
      if (!value.trim()) {
        continue;
      }
      const agentId = normalizeAgentId(value);
      if (!isSystemAgentId(agentId) && !agentsById.has(agentId)) {
        agentsById.set(agentId, { id: agentId });
      }
    }
    if (selectedId && !isSystemAgentId(selectedId) && !agentsById.has(selectedId)) {
      agentsById.set(selectedId, { id: selectedId });
    }
    const agents = [...agentsById.values()].toSorted((left, right) =>
      normalizeAgentLabel(left).localeCompare(normalizeAgentLabel(right)),
    );
    const selected = isSystemAgentId(selectedId)
      ? allowAll
        ? ""
        : (agents[0]?.id ?? "")
      : selectedId;
    const options: AgentSelectOption[] = [
      ...(allowAll ? [{ value: "", label: t("agentScope.allAgents"), icon: icons.users }] : []),
      ...agents.map((agent) => ({
        value: agent.id,
        label: normalizeAgentLabel(agent),
        agent,
      })),
    ];
    return { options, selected, allowAll };
  });
  return (
    <Show when={selection()}>
      {(control) => (
        <div class="agent-scope-control">
          <openclaw-agent-select
            prop:disabled={false}
            prop:options={control().options}
            prop:value={control().selected}
            prop:accessibleLabel={t("agentScope.label")}
            prop:menuLabel={t("agentScope.label")}
            prop:onSelect={(value: string) =>
              control().allowAll
                ? params.selection.setScope(value || null)
                : params.selection.set(value || null)
            }
          />
        </div>
      )}
    </Show>
  );
}
