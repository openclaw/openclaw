import { createMemo } from "solid-js";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { resolveUiDefaultAgentId } from "../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import "../styles/agent-row-chip.css";

type AgentRowChipProps = { agentId?: string };

export type AgentRowChipElement = SolidBridgeElement<AgentRowChipProps>;
export const AgentRowChip = defineSolidBridge<AgentRowChipProps>(
  "openclaw-agent-row-chip",
  (props) => {
    const context = projectSource(useOptionalApplication(), {
      read: (value) => value,
      subscribe: (value, notify) => {
        const stops = [value?.agents, value?.agentIdentity, value?.gateway].map((source) =>
          source?.subscribe(notify),
        );
        return () => stops.forEach((stop) => stop?.());
      },
      equality: "revision",
    });
    const view = createMemo(() => {
      const app = context.read();
      const agentsList = app?.agents.state.agentsList;
      const id =
        props.agentId?.trim() ||
        resolveUiDefaultAgentId({
          agentsList,
          hello: app?.gateway.snapshot.hello,
        });
      const agent = agentsList?.agents.find((entry) => entry.id === id) ?? { id };
      const identity = app?.agentIdentity.get(id);
      const name = normalizeAgentLabel(agent, identity);
      const label = name === id ? `agent:${id}` : `${name} (agent:${id})`;
      const avatar = resolveAgentAvatarUrl(agent, identity);
      return {
        id,
        name,
        label,
        avatar,
        textAvatar: resolveAgentTextAvatar(agent, identity),
      };
    });
    return (
      <span
        class="agent-row-chip"
        data-agent-id={view().id}
        role="img"
        aria-label={view().label}
        title={view().label}
      >
        <AgentIdentityAvatar
          agent={{ id: view().id, avatar: view().avatar, textAvatar: view().textAvatar }}
          class="agent-row-chip__avatar"
        />
        <span class="agent-row-chip__name">{view().name}</span>
      </span>
    );
  },
  { properties: { agentId: { default: undefined, attribute: false } } },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-row-chip": AgentRowChipElement;
  }
}
