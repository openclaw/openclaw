import { createMemo, createSignal, createUniqueId, Show } from "solid-js";
import { pathForAgentPanel } from "../app-route-paths.ts";
import { togglePinnedAgent } from "../app/bootstrap-navigation-preferences.ts";
import { patchSettings } from "../app/settings.ts";
import { registerAgentCreationEnglish } from "../i18n/locales/en-agent-creation.ts";
import { canDeleteAgent, deleteAgent } from "../lib/agents/delete-agent.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { projectAgents, projectRuntimeConfig } from "../lib/reactive/domain-capabilities.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { shareAgentAsTemplate, templateCreatorAction } from "../pages/templates/creator-owner.ts";
import { canCreateTemplateDraft } from "../pages/templates/draft-navigation.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { Icon } from "./solid/icon.tsx";
import { pointMenuTriggerAttributes } from "./solid/menu-trigger.tsx";
import { Menu, type MenuEntry } from "./solid/menu.tsx";

registerAgentCreationEnglish();

export type AgentRowContextMenu = { x: number; y: number; anchor: HTMLElement | null };

type AgentRowMenuHost = Pick<
  AppSidebarRenderHost,
  "sidebarAgentsMode" | "sidebarMenus" | "switchChipAgent" | "dismissTransientMenus" | "onNavigate"
>;

/**
 * One menu for every agent row. Its first group changes the list (one agent or all, or a new
 * agent), so it is the same from any row; the rest acts on the row's agent.
 */
export function SidebarAgentRowMenu(props: {
  host: AgentRowMenuHost;
  card: { id: string; name: string };
  /** Opens at the pointer or shortcut target instead of from the row's kebab. */
  point?: AgentRowContextMenu;
  othersUnread?: boolean;
  /** The roster moves the row between its pinned and listed sections. */
  onPin?: (agentId: string) => void;
  onClose?: () => void;
}) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const agents = projectAgents(context.agents);
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const navigation = projectOwner(context.navigation, (owner) => owner.snapshot);
  const roster = () => props.host.sidebarAgentsMode === "roster";
  // Creation opens its dialog and pending chat from the menu renderer; offer it once that is loaded.
  const [creationLoaded, setCreationLoaded] = createSignal(false);
  const loadCreation = () =>
    void props.host.sidebarMenus.preloadMenuRenderer().then(() => setCreationLoaded(true));
  const creationBlocked = () => {
    const snapshot = gateway.read().snapshot;
    if (canCallGatewayMethod(snapshot, "agents.create", "operator.admin")) {
      return null;
    }
    if (!snapshot.client || snapshot.phase !== "connected" || !snapshot.hello) {
      return t("agentChip.creationRequiresConnection");
    }
    if (isGatewayMethodAdvertised(snapshot, "agents.create") !== true) {
      return t("agentChip.creationUnsupported");
    }
    return t("agentChip.creationRequiresAdmin");
  };
  const items = createMemo((): MenuEntry[] => {
    const pinned = navigation.read().pinnedAgentIds.includes(props.card.id);
    const creating = Boolean(agents.read().pendingAgent);
    const blocked = creationBlocked();
    runtimeConfig.read();
    return [
      roster()
        ? {
            id: "show-only",
            label: t("agentsHome.showOnlyAgent"),
            class: "sidebar-customize-menu__item",
            icon: <Icon name="listFilter" />,
          }
        : {
            id: "show-all",
            label: t("agentsHome.showAllAgents"),
            class: "sidebar-customize-menu__item",
            icon: <Icon name="users" />,
            details: props.othersUnread ? (
              <span
                class="session-unread-dot"
                role="img"
                aria-label={t("agentsHome.otherAgentsUnread")}
              />
            ) : undefined,
          },
      {
        id: "new-agent",
        label: t(creating ? "agentChip.creatingAgent" : "agentChip.newAgent"),
        class: "sidebar-customize-menu__item",
        icon: <Icon name="circlePlus" />,
        disabled: Boolean(blocked || creating || !creationLoaded()),
        focusableWhenDisabled: Boolean(blocked && !creating),
        attributes: { "aria-description": blocked ?? undefined, title: blocked ?? undefined },
      },
      {
        kind: "content",
        id: "agent-separator",
        content: <div class="sidebar-customize-menu__separator" role="separator" />,
      },
      {
        id: "pin",
        label: t(pinned ? "nav.unpin" : "nav.pin"),
        class: ["sidebar-customize-menu__item", { "sidebar-agent-roster__pin--pinned": pinned }],
        icon: <Icon name="pin" />,
      },
      {
        id: "sessions",
        label: t("agentsHome.viewSessions"),
        class: "sidebar-customize-menu__item",
        icon: <Icon name="listTree" />,
      },
      // The one-agent row keeps the former agent menu's Share; roster rows keep Create template.
      ...(canCreateTemplateDraft(context)
        ? [
            roster()
              ? {
                  id: "create-template",
                  label: t("templatesDraft.title"),
                  class: "sidebar-customize-menu__item",
                  icon: <Icon name="share" />,
                }
              : {
                  id: "share",
                  label: t("agentChip.namedShare", { name: props.card.name }),
                  class: "sidebar-customize-menu__item",
                  icon: <Icon name="share" />,
                },
          ]
        : []),
      {
        id: "settings",
        label: t("nav.settings"),
        class: "sidebar-customize-menu__item",
        icon: <Icon name="settings" />,
      },
      {
        id: "delete",
        label: t("common.delete"),
        class: "sidebar-customize-menu__item",
        icon: <Icon name="trash" />,
        variant: "danger" as const,
        disabled: !canDeleteAgent(context, props.card.id),
      },
    ];
  });
  const select = (itemId: string) => {
    const id = props.card.id;
    const host = props.host;
    switch (itemId) {
      case "show-only":
        // The row it was chosen from is replaced; keep the keyboard on the same agent.
        host.sidebarMenus.requestAgentRowFocus(id);
        patchSettings({ sidebarAgentsMode: "chip" });
        host.switchChipAgent(id);
        break;
      case "show-all":
        host.sidebarMenus.requestAgentRowFocus(id);
        patchSettings({ sidebarAgentsMode: "roster" });
        context.agentSelection.setScope(null);
        break;
      case "new-agent":
        host.sidebarMenus.openAgentCreateDialog();
        break;
      case "pin":
        props.onPin?.(id);
        togglePinnedAgent(context.navigation, id);
        break;
      case "sessions":
        context.agentSelection.setScope(id);
        host.onNavigate?.("sessions");
        break;
      case "create-template":
        templateCreatorAction(context, id)?.();
        break;
      case "share":
        void shareAgentAsTemplate(context, id);
        break;
      case "settings":
        context.navigate("agents", { pathname: pathForAgentPanel(id, null, context.basePath) });
        break;
      case "delete":
        void deleteAgent(context, props.card);
        break;
    }
  };
  const point = () => props.point;
  const contextId = `sidebar-agent-row-context-${createUniqueId()}`;
  const label = () =>
    t(props.othersUnread ? "agentsHome.agentOptionsOthersUnread" : "agentsHome.agentOptions", {
      agent: props.card.name,
    });
  return (
    <Menu
      {...(point()
        ? { open: true, triggerAttributes: pointMenuTriggerAttributes(point()!) }
        : {
            lazy: true,
            triggerClass: "sidebar-agent-roster__action",
            trigger: (
              <>
                <Icon name="moreHorizontal" />
                <Show when={props.othersUnread}>
                  <span class="session-unread-dot sidebar-agent-roster__action-unread" />
                </Show>
              </>
            ),
          })}
      id={point() ? contextId : `sidebar-agent-row-${props.card.id}`}
      class="sidebar-customize-menu sidebar-agent-roster__menu"
      placement={point() ? "bottom-start" : "bottom-end"}
      label={label()}
      ref={({ overlay }) => {
        overlay.surface.dataset.chatAutotypeExempt = "";
        const opened = point();
        if (opened) {
          loadCreation();
          if (opened.anchor) {
            overlay.setReturnTarget(opened.anchor);
          }
          overlay.request(true, "first");
        }
      }}
      onBeforeShow={() => {
        loadCreation();
        if (!point()) {
          props.host.dismissTransientMenus();
        }
      }}
      onOpenChange={(open) => {
        if (point() && !open) {
          props.onClose?.();
        }
      }}
      onSelect={(item) => select(item.id)}
      items={items()}
    />
  );
}
