import type { ControlUiPanel } from "../../../../src/plugin-sdk/control-ui.js";
import { icons } from "../../components/icons.ts";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import { t } from "../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../i18n/locales/en-file-preview.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  emptyLegacyContent,
  solidContent,
  type LegacyTemplateResult,
} from "../../lit/solid-content.tsx";
import type { ControlUiRegistration } from "../../plugins/control-ui-capability.ts";
import { renderPluginContribution } from "../../plugins/control-ui-view.ts";
import type { SidebarPanelDefinitionParams } from "./chat-pane-embedded-types.ts";
import {
  BrowserPanel,
  ClearCompanion,
  CompanionPanel,
  DesktopPanel,
  DiscussionPanel,
  LinkReaderPanel,
  PortalPanel,
  PresentedPaneContent,
  ProcessesPanel,
  SubagentsPanel,
  TerminalPanel,
  UnavailableDetail,
  WorkspacePanel,
} from "./chat-pane-embedded-view.tsx";
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
    dashboardAvailable: () => params.dashboard !== emptyLegacyContent,
  };
  const definePanel = (
    slot: Exclude<SidebarSlotId, `plugin:${string}` | "link-reader">,
    icon: LegacyTemplateResult,
    content: SidebarPanelDefinition["content"],
    actions?: Pick<SidebarPanelDefinition, "headerAction" | "headerLink">,
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
      content,
      loading: solidContent(PanelLoadingSkeleton, {
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
      }),
      empty: { description: t(`chat.sidePanel.${textKey}Empty`) },
      ...actions,
      shortcut: SIDEBAR_PANEL_SHORTCUTS[slot]?.combo,
    };
  };
  const terminal = state?.terminalAvailable && params ? solidContent(TerminalPanel, params) : null;
  const browser =
    state?.browserPanelAvailable && params ? solidContent(BrowserPanel, params) : null;
  const companion = params ? solidContent(CompanionPanel, params) : null;
  const desktop = params?.desktopAvailable ? solidContent(DesktopPanel, params) : null;
  const discussion = params?.discussion ? solidContent(DiscussionPanel, params) : null;
  const portal = params ? solidContent(PortalPanel, params) : null;
  const workspace = state ? getSessionWorkspace(state) : null;
  // The region owns mounting and visibility. Hidden Review tabs must keep the
  // same cached diff loader so their live content and selection survive.
  const detailContent =
    state?.sidebarContent ?? (state ? resolveSessionDiffSidebarContent(state) : null);
  // The region mounts only tabs in the layout. Rendering Review starts its lazy
  // panel import, so default diff content must not build it before a tab exists.
  const detailTabPresent = layoutPanels.some((panel) => panel.slot === "detail");
  const workspaceContent =
    state && params && workspace
      ? solidContent(WorkspacePanel, { ...params, workspaceState: workspace })
      : (params?.workspace ?? null);
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
    definePanel("conversation", icons.messageSquare, emptyLegacyContent),
    definePanel("subagents", icons.bot, params ? solidContent(SubagentsPanel, params) : null),
    definePanel("processes", icons.terminal, params ? solidContent(ProcessesPanel, params) : null),
    definePanel(
      "detail",
      icons.diff,
      detailContent?.kind === "loading"
        ? solidContent(PanelLoadingSkeleton, { variant: "review", label: t("common.loading") })
        : detailContent?.kind === "unavailable"
          ? solidContent(UnavailableDetail, { message: detailContent.message })
          : detailContent && params && detailTabPresent
            ? solidContent(PresentedPaneContent, {
                presentation: state?.sidebarContent ? (params.panePresentation ?? true) : true,
                content: params.renderDetail(detailContent),
              })
            : null,
    ),
    definePanel("terminal", icons.terminal, terminal),
    definePanel("browser", icons.globe, browser),
    {
      slot: "link-reader",
      label: t("linkReader.title"),
      icon: icons.link,
      available: Boolean(params?.linkReaders?.length),
      content: params ? solidContent(LinkReaderPanel, params) : null,
      loading: solidContent(PanelLoadingSkeleton, {
        variant: "files",
        label: t("linkReader.loadingPreview"),
      }),
      empty: { description: t("linkReader.urlPlaceholder") },
    },
    definePanel("portal", icons.globe, portal),
    definePanel("workspace", icons.fileText, workspaceContent),
    definePanel("companion", icons.messageSquarePlus, companion, {
      headerAction: params ? solidContent(ClearCompanion, params) : undefined,
    }),
    definePanel("desktop", icons.monitor, desktop, {
      headerLink: panelExternalLink(params?.desktopFocusHref, t("desktop.openWindow")),
    }),
    definePanel("discussion", icons.messageSquare, discussion, {
      headerLink: panelExternalLink(
        params?.discussionOpenUrl,
        t("chat.sessionDiscussion.openExternal"),
      ),
    }),
    definePanel("dashboard", icons.layoutDashboard, params?.dashboard ?? null),
    ...[...pluginPanels].map(([slot, entry]): SidebarPanelDefinition => ({
      slot,
      label: entry?.value.label ?? slot.slice("plugin:".length),
      icon: icons.plug,
      available: entry !== undefined,
      content: entry
        ? renderPluginContribution(
            "panels",
            entry.key,
            { sessionKey: state?.sessionKey ?? "", agentId: params?.agentId ?? undefined },
            params?.isPluginPanelPresented(slot),
          )
        : null,
      loading: solidContent(PanelLoadingSkeleton, { variant: "files", label: t("common.loading") }),
      empty: { description: entry?.value.label ?? t("pluginTabs.unavailableSubtitle") },
    })),
  ];
}
