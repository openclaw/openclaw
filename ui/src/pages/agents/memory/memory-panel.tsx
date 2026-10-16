import { createEffect } from "solid-js";
import { ShellLayoutBoundary } from "../../../app/shell-layout-traits-solid.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { createAgentMemory } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";

type AgentMemoryPanelProps = { agentId: string };

export function AgentMemoryPanel(props: AgentMemoryPanelProps) {
  const state = createAgentMemory(useApplication());
  createEffect(() => props.agentId, state.setAgentId);
  return (
    <openclaw-agent-memory-panel>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <AgentMemoryView state={state} />
      </ShellLayoutBoundary>
    </openclaw-agent-memory-panel>
  );
}
