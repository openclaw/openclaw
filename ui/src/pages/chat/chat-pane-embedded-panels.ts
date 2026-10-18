import type { ControlUiPanel } from "../../../../src/plugin-sdk/control-ui.js";
import type { IconName } from "../../components/solid/icon.tsx";
import { t } from "../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../i18n/locales/en-file-preview.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { ControlUiRegistration } from "../../plugins/control-ui-capability.ts";
import type { SidebarPanelDefinitionParams, SidebarPanelData } from "./chat-pane-embedded-types.ts";
import { SIDEBAR_PANEL_SHORTCUTS } from "./chat-pane-panel-shortcuts.ts";
import { getSessionWorkspace } from "./components/chat-session-workspace-state.ts";
import { resolveSessionDiffSidebarContent } from "./components/chat-session-workspace.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";

registerFilePreviewEnglish();

function panelExternalLink(href: string | null | undefined, label: string) {
  return href ? { href, label } : undefined;
}

/** One ordered declaration for every chat side-panel slot. */
export function sidebarPanelDefinitions(
  params?: SidebarPanelDefinitionParams,
): SidebarPanelDefinition[] {
  const state = params?.state;
  const layoutPanels = state?.sidebarLayout.columns.flatMap((column) => column.panels) ?? [];
  // Metadata-only definitions have no pane context, so they describe types without offering tabs.
  const panelContext = params && {
    ...params,
    dashboardAvailable: () => params.dashboard !== null,
  };
  const definePanel = (
    slot: Exclude<SidebarSlotId, `plugin:${string}` | "link-reader">,
    icon: IconName,
    hasContent = true,
    actions?: Pick<SidebarPanelDefinition, "headerActionView" | "headerLink">,
  ): SidebarPanelDefinition => {
    const textKey = slot === "detail" ? "review" : slot === "workspace" ? "files" : slot;
    return {
      slot,
      label: t(`chat.sidePanel.${textKey}`),
      icon,
      available: Boolean(
        panelContext &&
        (slot === "portal"
          ? state &&
            canCallGatewayMethod(
              {
                hello: state.hello,
                client: state.client,
                phase: state.connected ? "connected" : "stopped",
              },
              "portal.list",
              "operator.read",
            )
          : slot === "subagents" || slot === "processes"
            ? panelContext.subagentsAvailable
            : SIDEBAR_PANEL_SHORTCUTS[slot]?.available(panelContext)),
      ),
      content: null,
      view: hasContent ? data : undefined,
      loading: {
        variant:
          textKey === "conversation" || textKey === "companion"
            ? "chat"
            : textKey === "subagents" || textKey === "processes"
              ? "file-list"
              : textKey === "portal"
                ? "browser"
                : textKey === "dashboard"
                  ? "board"
                  : textKey,
        label: t(textKey === "desktop" ? "desktop.connecting" : "common.loading"),
      },
      empty: { description: t(`chat.sidePanel.${textKey}Empty`) },
      ...actions,
      shortcut: SIDEBAR_PANEL_SHORTCUTS[slot]?.combo,
    };
  };
  const data: SidebarPanelData | undefined = params && {
    ...params,
    workspaceState: getSessionWorkspace(params.state),
    detailContent: params.state.sidebarContent ?? resolveSessionDiffSidebarContent(params.state),
    detailPresentation: params.state.sidebarContent ? (params.panePresentation ?? true) : true,
  };
  const pluginPanels = new Map<SidebarSlotId, ControlUiRegistration<ControlUiPanel> | undefined>(
    (params?.pluginPanels ?? []).map((entry) => [`plugin:${entry.key}`, entry]),
  );
  // Saved tabs outlive registrations, including during reconnect and activation.
  for (const { slot } of layoutPanels) {
    if (slot.startsWith("plugin:") && !pluginPanels.has(slot)) {
      pluginPanels.set(slot, undefined);
    }
  }
  return [
    definePanel("conversation", "messageSquare", false),
    definePanel("subagents", "bot"),
    definePanel("processes", "terminal"),
    definePanel("detail", "diff", Boolean(data?.detailContent)),
    definePanel("terminal", "terminal", Boolean(state?.terminalAvailable)),
    {
      ...definePanel("browser", "globe", Boolean(state?.browserPanelAvailable)),
      unavailableReason: state?.browserPanelUnavailableReason
        ? t(`chat.sidePanel.browserUnavailableReason.${state.browserPanelUnavailableReason}`)
        : undefined,
    },
    {
      slot: "link-reader",
      label: t("linkReader.title"),
      icon: "link",
      available: Boolean(params?.linkReaders?.length),
      content: null,
      view: data,
      loading: { variant: "files", label: t("linkReader.loadingPreview") },
      empty: { description: t("linkReader.urlPlaceholder") },
    },
    definePanel("portal", "globe"),
    definePanel("workspace", "fileText"),
    definePanel("companion", "messageSquarePlus", true, { headerActionView: params }),
    definePanel("desktop", "monitor", Boolean(params?.desktopAvailable), {
      headerLink:
        params?.presentation === "desktop"
          ? undefined
          : panelExternalLink(params?.desktopFocusHref, t("desktop.openWindow")),
    }),
    definePanel("discussion", "messageSquare", Boolean(params?.discussion), {
      headerLink: panelExternalLink(
        params?.discussionOpenUrl,
        t("chat.sessionDiscussion.openExternal"),
      ),
    }),
    definePanel("dashboard", "layoutDashboard", Boolean(params?.dashboard)),
    ...[...pluginPanels].map(([slot, entry]): SidebarPanelDefinition => ({
      slot,
      label: entry?.value.label ?? slot.slice("plugin:".length),
      icon: "plug",
      available: entry !== undefined,
      content: null,
      view: entry ? data : undefined,
      loading: { variant: "files", label: t("common.loading") },
      empty: { description: entry?.value.label ?? t("pluginTabs.unavailableSubtitle") },
    })),
  ];
}
