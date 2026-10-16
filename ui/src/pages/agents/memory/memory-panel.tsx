import { createEffect, onCleanup, untrack } from "solid-js";
import { ShellLayoutBoundary } from "../../../app/shell-layout-traits-solid.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { AgentMemoryState } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";

type AgentMemoryPanelProps = { agentId: string };

export function AgentMemoryPanel(props: AgentMemoryPanelProps) {
  const state = new AgentMemoryState();
  state.context = useApplication();
  state.agentId = untrack(() => props.agentId);
  state.connect();
  createEffect(
    () => props.agentId,
    (agentId) => {
      state.agentId = agentId;
    },
  );
  onCleanup(() => state.disconnect());
  return (
    <openclaw-agent-memory-panel>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <AgentMemoryView state={state} />
      </ShellLayoutBoundary>
    </openclaw-agent-memory-panel>
  );
}
