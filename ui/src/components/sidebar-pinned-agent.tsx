import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { agentRosterCards } from "../lib/agents/roster-activity.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import { Tooltip } from "./solid/tooltip.tsx";
import "../styles/sidebar-pinned-agents.css";

export function SidebarPinnedAgent(props: {
  agent: Pick<
    ReturnType<typeof agentRosterCards>[number],
    "id" | "name" | "avatar" | "textAvatar" | "assistantPreview"
  >;
  href: string;
  active: boolean;
  loading: boolean;
  deleting?: boolean;
  onOpen: () => void;
  menu: JSX.Element;
}) {
  return (
    <div
      class="sidebar-pinned-agent"
      data-pinned-agent={props.agent.id}
      aria-busy={props.deleting ? "true" : undefined}
    >
      <Tooltip class="sidebar-pinned-agent__tooltip" placement="right-start">
        <a
          class="sidebar-pinned-agent__link"
          data-agent-id={props.agent.id}
          href={props.href}
          aria-label={props.agent.name}
          aria-current={props.active ? "page" : undefined}
          onClick={(event: MouseEvent) => {
            if (shouldHandleNavigationClick(event)) {
              event.preventDefault();
              props.onOpen();
            }
          }}
        >
          <span class="sidebar-pinned-agent__avatar" aria-hidden="true">
            <AgentIdentityAvatar agent={props.agent} />
          </span>
          <span class="sidebar-pinned-agent__name">{props.agent.name}</span>
          <Show when={props.deleting}>
            <span class="sidebar-pinned-agent__name" role="status">
              {t("agentsHome.deletingAgent")}
            </span>
          </Show>
        </a>
        <span slot="content" class="sidebar-pinned-agent__card">
          <span class="sidebar-pinned-agent__card-header">
            <span class="sidebar-pinned-agent__avatar" aria-hidden="true">
              <AgentIdentityAvatar agent={props.agent} />
            </span>
            <span>{props.agent.name}</span>
          </span>
          <span class="sidebar-pinned-agent__preview">
            {props.agent.assistantPreview ||
              t(props.loading ? "common.loading" : "agentsHome.noAssistantMessage")}
          </span>
        </span>
      </Tooltip>
      {props.menu}
    </div>
  );
}
