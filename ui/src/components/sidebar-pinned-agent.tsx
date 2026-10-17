import type { JSX } from "@solidjs/web";
import type { agentRosterCards } from "../lib/agents/roster-activity.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import { SessionGlyph, sessionRunVisibility } from "./solid/session-presentation.tsx";
import "../styles/sidebar-pinned-agents.css";

export function SidebarPinnedAgent(props: {
  agent: Pick<
    ReturnType<typeof agentRosterCards>[number],
    "id" | "name" | "avatar" | "textAvatar" | "assistantPreview" | "activeNow"
  >;
  href: string;
  active: boolean;
  loading: boolean;
  onOpen: () => void;
  menu: JSX.Element;
}) {
  return (
    <div class="sidebar-pinned-agent session-row-host" data-pinned-agent={props.agent.id}>
      <openclaw-tooltip class="sidebar-pinned-agent__tooltip" prop:placement="right-start">
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
            <SessionGlyph
              circular
              content={<AgentIdentityAvatar agent={props.agent} />}
              running={props.agent.activeNow}
              runVisibility={sessionRunVisibility}
            />
          </span>
          <span class="sidebar-pinned-agent__name">{props.agent.name}</span>
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
      </openclaw-tooltip>
      {props.menu}
    </div>
  );
}
