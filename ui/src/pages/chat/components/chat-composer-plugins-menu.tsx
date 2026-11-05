import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuControls, MenuEntry, MenuItemBindings } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  nextBooleanToolOverrides,
  readOwnEntry,
  resolveToolOverrideState,
} from "../../../lib/sessions/tool-overrides.ts";
import {
  toolsForServer,
  isToolDenied,
  mcpDiscoveryNotice,
  labelsForMcpTools,
} from "./chat-composer-menu-inputs.ts";
import {
  MenuSwitch,
  renderBackRow,
  renderCapabilityMenuState,
  renderCapabilityToggleRow,
  menuDivider,
} from "./chat-composer-menu-rows.tsx";
import type { ChatComposerPlusMenuContentProps } from "./chat-composer-plus-menu.types.ts";

function pluginTools(
  menu: ChatComposerPlusMenuContentProps,
  serverName: string,
  controls: MenuControls,
  readMenu: () => ChatComposerPlusMenuContentProps,
): MenuEntry[] {
  const tools = toolsForServer(menu.toolsEffectiveResult, serverName);
  const notice = mcpDiscoveryNotice(menu.toolsEffectiveResult, serverName);
  if (menu.toolsEffectiveLoading) {
    return [
      renderCapabilityMenuState(
        "tools-loading",
        t("chat.composer.menu.toolAccess.loading"),
        "status",
      ),
    ];
  }
  if (menu.toolsEffectiveError) {
    return [
      renderCapabilityMenuState(
        "tools-error",
        <>
          {t("chat.composer.menu.serverNoResponse")}{" "}
          <button
            type="button"
            class="agent-chat__capability-menu-text-action"
            ref={controls.ref()}
            onClick={() => readMenu().onOpenToolAccess?.(serverName)}
          >
            {t("common.retry")}
          </button>
        </>,
        "status",
      ),
    ];
  }
  if (!tools.length) {
    return [
      renderCapabilityMenuState(
        "tools-empty",
        notice ?? t("chat.composer.menu.toolAccess.noTools"),
        notice ? "status" : undefined,
      ),
    ];
  }
  const labels = labelsForMcpTools(tools);
  const allOn = tools.every((tool) => !isToolDenied(menu, tool));
  return [
    {
      id: "tools-all",
      label: t(allOn ? "chat.composer.menu.turnAllOff" : "chat.composer.menu.turnAllOn"),
      class: "agent-chat__capability-menu-item agent-chat__capability-menu-tools-heading",
      icon: <span />,
      content: t("chat.composer.menu.tools"),
      details: (
        <span>{t(allOn ? "chat.composer.menu.turnAllOff" : "chat.composer.menu.turnAllOn")}</span>
      ),
      disabled: menu.toolAccessMutationBlockedReason !== null,
      closeOnSelect: false,
    },
    ...tools.map((tool) =>
      renderCapabilityToggleRow({
        value: `mcp-tool:${tool.mcpToolName}`,
        label: labels.get(tool.mcpToolName) ?? tool.mcpToolName,
        checked: !isToolDenied(menu, tool),
        disabled: menu.toolAccessMutationBlockedReason !== null,
        title: menu.toolAccessMutationBlockedReason,
      }),
    ),
  ];
}

function ServerRow(props: {
  attributes: MenuItemBindings;
  menu: ChatComposerPlusMenuContentProps;
  name: string;
  controls: MenuControls;
  expanded: boolean;
}) {
  const server = () => props.menu.mcpServers.find((entry) => entry.name === props.name);
  const enabled = () =>
    resolveToolOverrideState(
      server()?.enabled ?? false,
      readOwnEntry(props.menu.toolOverrides?.mcpServers, props.name),
    );
  return (
    <div
      {...props.attributes}
      aria-expanded={props.menu.onOpenToolAccess ? (props.expanded ? "true" : "false") : undefined}
      class="oc-menu-item agent-chat__capability-menu-item agent-chat__capability-menu-server"
    >
      <span class="oc-menu-item__icon">
        <Icon name="plug" />
      </span>
      <span class="oc-menu-item__label">{props.name}</span>
      <span class="oc-menu-item__details">
        <button
          ref={props.controls.ref()}
          type="button"
          class="agent-chat__capability-menu-switch-button"
          role="switch"
          aria-label={props.name}
          aria-checked={enabled() ? "true" : "false"}
          disabled={props.menu.mutationBlockedReason !== null}
          title={props.menu.mutationBlockedReason ?? undefined}
          onClick={(event) => {
            event.stopPropagation();
            const entry = server();
            if (!entry || props.menu.mutationBlockedReason) {
              return;
            }
            props.menu.onPatchToolOverrides(
              nextBooleanToolOverrides(
                props.menu.toolOverrides,
                "mcpServers",
                entry.name,
                !enabled(),
                entry.enabled,
              ),
            );
          }}
        >
          <MenuSwitch checked={enabled()} />
        </button>
      </span>
    </div>
  );
}

export function connectorItems(
  menu: ChatComposerPlusMenuContentProps,
  expanded: string | null,
  controls: MenuControls,
  readMenu: () => ChatComposerPlusMenuContentProps,
  readExpanded: () => string | null,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (menu.mcpServersReadState !== "ready") {
    entries.push(
      renderCapabilityMenuState(
        "connectors-unavailable",
        t(
          menu.mcpServersReadState === "restricted"
            ? "chat.composer.menu.pluginSettingsRestricted"
            : menu.mcpServersReadState === "loading"
              ? "common.loading"
              : "chat.composer.menu.pluginSettingsUnavailable",
        ),
        menu.mcpServersReadState === "loading" ? "status" : undefined,
      ),
    );
  } else if (!menu.mcpServers.length) {
    entries.push(
      renderCapabilityMenuState(
        "no-connectors",
        t(menu.canAdmin ? "chat.composer.menu.noServers" : "chat.composer.menu.noConnectors"),
      ),
    );
  }
  for (const server of menu.mcpServers) {
    entries.push({
      id: `server:${server.name}`,
      label: server.name,
      render: (attributes) => (
        <ServerRow
          attributes={attributes}
          name={server.name}
          menu={readMenu()}
          controls={controls}
          expanded={readExpanded() === server.name}
        />
      ),
      closeOnSelect: false,
    });
    if (expanded === server.name) {
      entries.push(...pluginTools(menu, server.name, controls, readMenu));
    }
  }
  const footer: MenuEntry[] = [menuDivider("connectors-footer")];
  if (menu.onAddServer) {
    footer.push({
      id: "add-server",
      label: t("chat.composer.menu.addMcpServer"),
      class: "agent-chat__capability-menu-item",
      icon: <Icon name="plus" />,
      disabled: !menu.canAdmin,
      attributes: { title: menu.adminBlockedReason ?? "" },
    });
  }
  footer.push({
    id: "manage-plugins",
    label: t("chat.composer.menu.managePlugins"),
    href: pathForRoute("plugins", menu.basePath),
    class: "agent-chat__capability-menu-item",
    icon: <Icon name="settings" />,
  });
  return [
    renderBackRow(t("chat.composer.menu.connectors")),
    menuDivider("connectors-header"),
    {
      kind: "group",
      id: "connectors-list",
      class: "agent-chat__capability-menu-scroll",
      items: entries,
    },
    { kind: "group", id: "connectors-footer-group", items: footer },
  ];
}
