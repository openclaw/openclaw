import { createMemo } from "solid-js";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { projectAgentRowContext } from "../lib/reactive/agent-row-context.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { resolveUiDefaultAgentId } from "../lib/sessions/session-key.ts";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import "../styles/agent-row-chip.css";

export function AgentRowChip(props: { agentId?: string }) {
  const agentId = createMemo(() => props.agentId?.trim());
  const context = projectAgentRowContext(useOptionalApplication());
  const view = createMemo(() => {
    const app = context.read();
    const agentsList = app?.agents.state.agentsList;
    const id =
      agentId() ||
      resolveUiDefaultAgentId({
        agentsList,
        hello: app?.gateway.snapshot.hello,
      });
    const agent = agentsList?.agents.find((entry) => entry.id === id) ?? { id };
    const identity = app?.agentIdentity.get(id);
    const name = normalizeAgentLabel(agent, identity);
    const label = name === id ? `agent:${id}` : `${name} (agent:${id})`;
    const avatar = resolveAgentAvatarUrl(agent, identity);
    const textAvatar = resolveAgentTextAvatar(agent, identity);
    return { id, name, label, avatar, textAvatar };
  });
  return (
    <openclaw-agent-row-chip>
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
    </openclaw-agent-row-chip>
  );
}
