import { ShellLayoutBoundary } from "../../../app/shell-layout-traits-solid.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { createAgentMemory, type AgentMemoryTarget } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";

type AgentMemoryPanelProps = { initialAgentTarget: AgentMemoryTarget };

export function AgentMemoryPanel(props: AgentMemoryPanelProps) {
  const state = createAgentMemory(useApplication(), () => props.initialAgentTarget);
  return (
    <openclaw-agent-memory-panel>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <AgentMemoryView state={state} />
      </ShellLayoutBoundary>
    </openclaw-agent-memory-panel>
  );
}
