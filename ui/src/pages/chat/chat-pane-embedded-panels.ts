import type { ControlUiFocusBuildTarget } from "@openclaw/session-url-contract";
import { html, nothing, type TemplateResult } from "lit";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { ControlUiPanel } from "../../../../src/plugin-sdk/control-ui.js";
import type { ControlUiLinkReaderDescriptor } from "../../../../src/shared/control-ui-link-reader.js";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import type {
  BrowserTabSelection,
  BrowserTabTarget,
} from "../../components/browser/browser-target.ts";
import { icons } from "../../components/icons.ts";
import { EMPTY_LINK_READERS } from "../../components/link-reader-target.ts";
import { renderPanelLoadingSkeleton } from "../../components/panel-loading-skeleton.ts";
import { t } from "../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../i18n/locales/en-file-preview.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  livePresentation,
  presentedContent,
  presentedProperty,
  type PresentationValue,
} from "../../lit/presentation-binding.ts";
import type { ControlUiRegistration } from "../../plugins/control-ui-capability.ts";
import { renderPluginContribution } from "../../plugins/control-ui-view.ts";
import { SIDEBAR_PANEL_SHORTCUTS } from "./chat-pane-panel-shortcuts.ts";
import type { PaneSessionChangeOptions } from "./chat-pane-shared.ts";
import type {
  ChatSessionCompanionThread,
  ChatSessionCompanionTurn,
} from "./chat-session-companion.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAttachmentLimits } from "./components/chat-attachment-admission.ts";
import {
  getSessionWorkspace,
  selectSessionWorkspacePreview,
  closeSessionWorkspacePreview,
} from "./components/chat-session-workspace-state.ts";
import { resolveSessionDiffSidebarContent } from "./components/chat-session-workspace.ts";
import type { SidebarContent } from "./components/chat-sidebar-content-types.ts";
import type { SidebarPanelDefinition } from "./components/chat-sidebar-region-types.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";
import { sidebarMainPanel } from "./sidebar-layout.ts";

registerFilePreviewEnglish();

type SidebarPanelDefinitionParams = {
  panePresentation?: PresentationValue;
  state: ChatPageHost;
  paneId: string;
  panePresentationId: string;
  subagentsInputRegion: "page" | "dock";
  subagentsPresented: PresentationValue;
  processesPresented?: PresentationValue;
  onRefreshProcesses?: () => void;
  subagentsAvailable: boolean;
  subagentsShowRequest?: () => string | null | undefined;
  onRefreshSubagents: () => void;
  onSubagentSessionSelect: (
    sessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean | void;
  themeMode: "dark" | "light";
  agentId: string | null;
  browserPresented: PresentationValue;
  browserTabsInHeader: boolean;
  linkReaders?: readonly ControlUiLinkReaderDescriptor[];
  linkReaderPresented?: PresentationValue;
  linkReaderTabsInHeader?: boolean;
  onCloseLinkReader?: () => void;
  terminalTabsInHeader: boolean;
  onCloseTerminal?: () => void;
  browserRefreshOnPresentation: boolean;
  preferredBrowserTab?: BrowserTabSelection;
  sessionBrowserTabs?: BrowserTabTarget[];
  desktopPresented: PresentationValue;
  desktopRefreshOnPresentation: boolean;
  desktopAvailable: boolean;
  desktopSource: string | null;
  desktopFocusHref: string;
  portalPresented?: PresentationValue;
  onDesktopFocusTargetChange: (
    target: Extract<ControlUiFocusBuildTarget, { kind: "desktop" }>,
  ) => void;
  dashboard: TemplateResult | typeof nothing;
  workspace: TemplateResult | typeof nothing;
  renderDetail: (content: SidebarContent) => TemplateResult;
  digest: SessionObserverDigest | null;
  activeRunId: string | null;
  pullRequests: ControlUiSessionPullRequest[];
  companion: ChatSessionCompanionThread;
  companionPresented: PresentationValue;
  companionFocusRequest: (() => boolean) | undefined;
  onCompanionSubmit: (question: string | ChatSessionCompanionTurn) => void;
  onCompanionDraftChange: (draft: string) => void;
  onCompanionAttachmentsChange?: (attachments: ChatAttachment[]) => boolean | void;
  connected: boolean;
  onClearCompanion: () => void;
  discussion: SessionDiscussionPanelConfig | null;
  discussionAvailable: boolean;
  discussionOpenUrl: string | null;
  discussionSourceGeneration: number;
  pluginPanels: ControlUiRegistration<ControlUiPanel>[];
  isPluginPanelPresented: (slot: SidebarSlotId) => PresentationValue;
};

type SidebarPanelTextKey =
  | Exclude<SidebarSlotId, `plugin:${string}` | "detail" | "workspace" | "link-reader">
  | "review"
  | "files";

function panelExternalLink(href: string | null | undefined, label: string) {
  return href
    ? html`<a
        class="rail-header__action"
        href=${href}
        target="_blank"
        rel="noopener"
        aria-label=${label}
        title=${label}
        >${icons.externalLink}</a
      >`
    : undefined;
}

/** One ordered declaration for every chat side-panel slot. */
export function sidebarPanelDefinitions(
  params?: SidebarPanelDefinitionParams,
): SidebarPanelDefinition[] {
  const state = params?.state;
  // Metadata-only definitions have no pane context, so they describe types without offering tabs.
  const panelContext = params && {
    ...params,
    dashboardAvailable: () => params.dashboard !== nothing,
  };
  const definePanel = (
    slot: Exclude<SidebarSlotId, `plugin:${string}`>,
    textKey: SidebarPanelTextKey,
    icon: TemplateResult,
    content: TemplateResult | typeof nothing | null,
    headerAction?: TemplateResult,
  ): SidebarPanelDefinition => ({
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
    loading: renderPanelLoadingSkeleton(
      textKey === "conversation" || textKey === "companion"
        ? "chat"
        : textKey === "subagents" || textKey === "processes"
          ? "file-list"
          : textKey === "portal"
            ? "browser"
            : textKey === "dashboard"
              ? "board"
              : textKey,
      t(textKey === "desktop" ? "desktop.connecting" : "common.loading"),
    ),
    empty: { description: t(`chat.sidePanel.${textKey}Empty`) },
    headerAction,
    shortcut: SIDEBAR_PANEL_SHORTCUTS[slot]?.combo,
  });
  const terminal = state?.terminalAvailable
    ? html`<openclaw-terminal-panel
        embedded
        .tabsInHeader=${params?.terminalTabsInHeader ?? false}
        .onClose=${params?.onCloseTerminal}
        .client=${state.connected ? state.client : null}
        .available=${state.terminalAvailable}
        .agentId=${params?.agentId ?? null}
        .sessionKey=${state.sessionKey}
        .themeMode=${params?.themeMode ?? "dark"}
        .basePath=${state.basePath}
      ></openclaw-terminal-panel>`
    : null;
  const browser = state?.browserPanelAvailable
    ? html`<openclaw-browser-panel
        embedded
        data-chat-autotype-exempt
        .client=${state.connected ? state.client : null}
        .available=${state.browserPanelAvailable}
        .remoteAvailable=${isBrowserPanelAvailable({
          phase: state.connected ? "connected" : "offline",
          hello: state.hello,
        })}
        .presented=${livePresentation(params?.browserPresented ?? false)}
        .tabsInHeader=${params?.browserTabsInHeader ?? false}
        .refreshOnPresentation=${params?.browserRefreshOnPresentation ?? true}
        .sessionKey=${state.sessionKey}
        .preferredTab=${params?.preferredBrowserTab}
        .sessionTabs=${params?.sessionBrowserTabs ?? []}
        .resourceBasePath=${state.resourceBasePath}
        .authToken=${resolveControlUiAuthToken(state)}
      ></openclaw-browser-panel>`
    : null;
  const companion = params
    ? html`<openclaw-chat-session-rail
        .presented=${livePresentation(params.companionPresented)}
        .focusRequest=${params.companionFocusRequest}
        .sessionKey=${state?.sessionKey}
        .digest=${params.digest}
        .running=${Boolean(params.activeRunId)}
        .activeRunId=${params.activeRunId}
        .pullRequests=${params.pullRequests}
        .companion=${params.companion}
        .connected=${state?.connected === true}
        .sendShortcut=${state?.settings.chatSendShortcut ?? "enter"}
        .onSubmit=${params.onCompanionSubmit}
        .onDraftChange=${params.onCompanionDraftChange}
        .onAttachmentsChange=${params.onCompanionAttachmentsChange}
        .uploadConfig=${state?.uploadConfig}
        .attachmentLimits=${resolveChatAttachmentLimits(state?.hello?.policy)}
      ></openclaw-chat-session-rail>`
    : null;
  const desktop =
    state && params?.desktopAvailable
      ? html`<openclaw-desktop-panel
          embedded
          data-chat-autotype-exempt
          .client=${state.connected ? state.client : null}
          .available=${params.desktopAvailable}
          .presented=${livePresentation(params?.desktopPresented ?? false)}
          .refreshOnPresentation=${params?.desktopRefreshOnPresentation ?? true}
          .requestedSource=${params?.desktopSource ?? null}
          .sessionKey=${state.sessionKey}
          .onFocusTargetChange=${params?.onDesktopFocusTargetChange}
        ></openclaw-desktop-panel>`
      : null;
  const discussion = params?.discussion
    ? html`<openclaw-session-discussion
        .sessionKey=${params.discussion.sessionKey}
        .canOpen=${params.discussion.canOpen}
        .sourceGeneration=${params.discussionSourceGeneration}
        .loadInfo=${params.discussion.loadInfo}
        .openDiscussion=${params.discussion.openDiscussion}
        .onStateChange=${params.discussion.onStateChange}
      ></openclaw-session-discussion>`
    : null;
  const portal = state
    ? html`<openclaw-portals-page
        embedded
        .presented=${livePresentation(params?.portalPresented ?? false)}
        .requestedPortalId=${state.sidebarLayout.columns.flatMap((column) => column.panels).find((panel) => panel.slot === "portal")?.portalId ?? null}
        .requestedEnvironmentId=${state.sidebarLayout.columns.flatMap((column) => column.panels).find((panel) => panel.slot === "portal")?.environmentId ?? null}
      ></openclaw-portals-page>`
    : null;
  const workspace = state ? getSessionWorkspace(state) : null;
  // The region owns mounting and visibility. Hidden Review tabs must keep the
  // same cached diff loader so their live content and selection survive.
  const detailContent =
    state?.sidebarContent ?? (state ? resolveSessionDiffSidebarContent(state) : null);
  // The region mounts only tabs in the layout. Rendering Review starts its lazy
  // panel import, so default diff content must not build it before a tab exists.
  const detailTabPresent =
    state?.sidebarLayout.columns.some((column) =>
      column.panels.some((panel) => panel.slot === "detail"),
    ) ?? false;
  const workspaceContent =
    state && params && workspace
      ? html`<openclaw-chat-files-panel
          .tabsInHeader=${sidebarMainPanel(state.sidebarLayout)?.slot !== "workspace"}
          .previews=${presentedProperty(params.panePresentation ?? true, workspace.previews, [])}
          .activeId=${presentedProperty(params.panePresentation ?? true, workspace.activePreviewId, null)}
          .browser=${params.workspace}
          .renderDetail=${params.renderDetail}
          .onSelect=${(id: string | null) => selectSessionWorkspacePreview(state, id)}
          .onClose=${(id: string) => closeSessionWorkspacePreview(state, id)}
        ></openclaw-chat-files-panel>`
      : (params?.workspace ?? null);
  const pluginPanels = new Map<SidebarSlotId, ControlUiRegistration<ControlUiPanel> | undefined>(
    (params?.pluginPanels ?? []).map((entry) => [`plugin:${entry.key}`, entry]),
  );
  // Saved tabs outlive registrations, including during reconnect and activation.
  for (const column of state?.sidebarLayout.columns ?? []) {
    for (const { slot } of column.panels) {
      if (slot.startsWith("plugin:") && !pluginPanels.has(slot)) {
        pluginPanels.set(slot, undefined);
      }
    }
  }
  return [
    definePanel("conversation", "conversation", icons.messageSquare, nothing),
    definePanel(
      "subagents",
      "subagents",
      icons.bot,
      state && params
        ? html`<openclaw-chat-subagents-panel
            .sessionKey=${state.sessionKey}
            .agentId=${params.agentId ?? "main"}
            .paneId=${params.paneId}
            .presentationId=${params.panePresentationId}
            .inputRegion=${params.subagentsInputRegion}
            .presented=${livePresentation(params.subagentsPresented)}
            .showRequest=${params.subagentsShowRequest}
            .onSessionSelect=${params.onSubagentSessionSelect}
          ></openclaw-chat-subagents-panel>`
        : null,
      params
        ? html`<button
            type="button"
            class="rail-header__action"
            aria-label=${t("chat.subagentsPanel.refresh")}
            title=${t("chat.subagentsPanel.refresh")}
            ?disabled=${!params.connected}
            @click=${params.onRefreshSubagents}
          >
            ${icons.refresh}
          </button>`
        : undefined,
    ),
    definePanel(
      "processes",
      "processes",
      icons.terminal,
      state && params
        ? html`<openclaw-chat-processes-panel
            .sessionKey=${state.sessionKey}
            .agentId=${params.agentId ?? "main"}
            .presented=${livePresentation(params.processesPresented ?? false)}
          ></openclaw-chat-processes-panel>`
        : null,
      params
        ? html`<button
            type="button"
            class="rail-header__action"
            aria-label=${t("chat.processesPanel.refresh")}
            title=${t("chat.processesPanel.refresh")}
            ?disabled=${!params.connected}
            @click=${params.onRefreshProcesses}
          >
            ${icons.refresh}
          </button>`
        : undefined,
    ),
    definePanel(
      "detail",
      "review",
      icons.diff,
      detailContent?.kind === "loading"
        ? renderPanelLoadingSkeleton("review", t("common.loading"))
        : detailContent?.kind === "unavailable"
          ? html`<div class="callout danger review-unavailable" role="alert">
              <strong>${t("chat.detailPanel.unavailable")}</strong>
              <span>${detailContent.message}</span>
            </div>`
          : detailContent && params && detailTabPresent
            ? html`${presentedContent(
                state?.sidebarContent ? (params.panePresentation ?? true) : true,
                params.renderDetail(detailContent),
              )}`
            : null,
    ),
    definePanel("terminal", "terminal", icons.terminal, terminal),
    definePanel("browser", "browser", icons.globe, browser),
    {
      slot: "link-reader",
      label: t("linkReader.title"),
      icon: icons.link,
      available: Boolean(params?.linkReaders?.length),
      content: state
        ? html`<openclaw-link-reader-panel
            embedded
            data-chat-autotype-exempt
            .client=${state.connected ? state.client : null}
            .available=${state.connected}
            .readers=${params?.linkReaders ?? EMPTY_LINK_READERS}
            .agentId=${params?.agentId ?? undefined}
            .sessionKey=${state.sessionKey}
            .presented=${livePresentation(params?.linkReaderPresented ?? false)}
            .tabsInHeader=${params?.linkReaderTabsInHeader ?? true}
            .onClose=${params?.onCloseLinkReader}
          ></openclaw-link-reader-panel>`
        : null,
      loading: renderPanelLoadingSkeleton("files", t("linkReader.loadingPreview")),
      empty: { description: t("linkReader.urlPlaceholder") },
    },
    definePanel("portal", "portal", icons.globe, portal),
    definePanel("workspace", "files", icons.fileText, workspaceContent),
    definePanel(
      "companion",
      "companion",
      icons.messageSquarePlus,
      companion,
      params
        ? html`<openclaw-tooltip .content=${t("chat.rail.clear")}>
            <button
              class="rail-header__action chat-session-rail__clear"
              type="button"
              aria-label=${t("chat.rail.clear")}
              ?disabled=${!params.connected || params.companion.turns.some((turn) => turn.status === "pending")}
              @click=${params.onClearCompanion}
            >
              ${icons.trash}
            </button>
          </openclaw-tooltip>`
        : undefined,
    ),
    definePanel(
      "desktop",
      "desktop",
      icons.monitor,
      desktop,
      panelExternalLink(params?.desktopFocusHref, t("desktop.openWindow")),
    ),
    definePanel(
      "discussion",
      "discussion",
      icons.messageSquare,
      discussion,
      panelExternalLink(params?.discussionOpenUrl, t("chat.sessionDiscussion.openExternal")),
    ),
    definePanel("dashboard", "dashboard", icons.layoutDashboard, params?.dashboard ?? null),
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
      loading: renderPanelLoadingSkeleton("files", t("common.loading")),
      empty: { description: entry?.value.label ?? t("pluginTabs.unavailableSubtitle") },
    })),
  ];
}
