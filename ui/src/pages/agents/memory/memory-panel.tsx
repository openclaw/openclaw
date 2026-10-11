import { createEffect, onCleanup, untrack, useContext } from "solid-js";
import { shellLayoutOwnerForHost } from "../../../app/shell-layout-owner.ts";
import {
  ShellLayoutBoundary,
  ShellLayoutProvider,
} from "../../../app/shell-layout-traits-solid.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { AgentMemoryState } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";

type AgentMemoryPanelProps = { agentId: string };

export const AgentMemoryPanel = defineSolidBridge<AgentMemoryPanelProps>(
  "openclaw-agent-memory-panel",
  (props, host) => {
    const inherited = useContext(ShellLayoutProvider);
    const owner = inherited?.owner ?? shellLayoutOwnerForHost(host);
    return (
      <ShellLayoutProvider value={inherited ?? (owner ? { owner, host } : null)}>
        <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
          <AgentMemoryContent {...props} />
        </ShellLayoutBoundary>
      </ShellLayoutProvider>
    );
  },
  { properties: { agentId: { default: "", attribute: false } } },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-memory-panel": SolidBridgeElement<AgentMemoryPanelProps>;
  }
}

function AgentMemoryContent(props: AgentMemoryPanelProps) {
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
  return <AgentMemoryView state={state} />;
}
