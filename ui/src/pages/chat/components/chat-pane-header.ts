import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import { html, nothing, type TemplateResult } from "lit";
import { buildControlUiResourcePath } from "../../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewaySessionRow, SessionBranch } from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../../app/control-ui-auth.ts";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import {
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import { icons } from "../../../components/icons.ts";
import { renderKeyboardShortcut } from "../../../components/kbd.ts";
import {
  personActivityLink,
  renderStandalonePersonLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { renderSessionColorDot } from "../../../components/session-color.ts";
import { renderSessionOwnerChip } from "../../../components/session-owner-chip.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import "../../../components/tooltip.ts";
import "../../../components/workspace-icon.ts";
import { t } from "../../../i18n/index.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
} from "../../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import {
  ensureSidebarConversation,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  sidebarActivePanel,
  sidebarDock,
  sidebarMainPanel,
  toggleSidebarPanelExpanded,
  type SidebarLayout,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import type { HeaderMenuQuickAction } from "./chat-header-session-menu.ts";
import "./chat-pane-versions-menu.tsx";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";

export type ChatPaneHeaderAction = "reveal" | "copy-path" | "copy-branch";

const pendingLayoutActions = new WeakMap<EventTarget, () => void>();

type ChatPaneParentSession = {
  key: string;
  title: string;
};

type ChatPaneHeaderProps = {
  paneId: string;
  narrow: boolean;
  mergedChrome: boolean;
  navDrawerOpen?: boolean;
  title: string;
  session: GatewaySessionRow | undefined;
  incognito?: boolean;
  showOwnerChip?: boolean;
  ownerViewing?: boolean;
  personActivity?: PersonActivityRouting;
  catalog: boolean;
  catalogColor?: string;
  editing: boolean;
  renameValue: string;
  workspaceRoot: string | null;
  workspaceLabel: string | null;
  /** Gateway-resolved project icon for the chip; absent keeps the folder glyph. */
  workspaceIcon: {
    routeUrl: string;
    authTokens: readonly string[];
    authReady: boolean;
    connectionId?: string;
  } | null;
  parentSession: ChatPaneParentSession | null;
  branch: string | null;
  branches: SessionBranch[];
  branchSwitchDisabledReason: string | null;
  platform: string | null;
  canReveal: boolean;
  copiedAction: ChatPaneHeaderAction | null;
  renameDisabledReason?: string;
  actionsDisabled?: boolean;
  panelMenuActions?: (HeaderMenuQuickAction & { shortcut?: KeyboardShortcutCombo })[];
  layoutMenuActions?: HeaderMenuQuickAction[];
  sidebarLayout?: SidebarLayout;
  panelDefinitions?: SidebarPanelDefinition[];
  onLayoutChange?: ChatPageHost["updateSidebarLayout"];
  onToggleSidePanel?: () => void;
  onCloseSidePanel?: (slot: SidebarSlotId) => void;
  runningSubagentCount?: number;
  detailsControl?: TemplateResult | typeof nothing;
  runAction?: TemplateResult | typeof nothing;
  presence?: TemplateResult | typeof nothing;
  sharingControl?: TemplateResult | typeof nothing;
  publicAccessIndicator?: TemplateResult | typeof nothing;
  placementControl?: TemplateResult | typeof nothing;
  sessionMenuAction: TemplateResult | typeof nothing;
  onBeginRename: () => void;
  onRenameInput: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onMenuAction: (action: ChatPaneHeaderAction) => void;
  onOpenParentSession: (sessionKey: string) => void;
  onBranchSelect: (leafEntryId: string) => void;
  onOpenSplitView?: () => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
};

function revealLabel(platform: string | null): string {
  if (platform === "darwin") {
    return t("chat.sessionHeader.revealFinder");
  }
  if (platform === "win32") {
    return t("chat.sessionHeader.revealFileExplorer");
  }
  return t("chat.sessionHeader.revealFileManager");
}

export function resolveChatPaneParentSession(
  session: GatewaySessionRow | undefined,
  sessions: readonly GatewaySessionRow[],
): ChatPaneParentSession | null {
  const parentKey = resolveUiSessionNavigationParentKey(session);
  if (!parentKey || (session && areUiSessionKeysEquivalent(parentKey, session.key))) {
    return null;
  }
  const parent = sessions.find((row) => areUiSessionKeysEquivalent(row.key, parentKey));
  return parent ? { key: parent.key, title: resolveSessionDisplayName(parent.key, parent) } : null;
}

function renderIdentityCrumbs(props: ChatPaneHeaderProps) {
  const projectCrumb = renderProjectCrumb(props);
  const parentCrumb = renderParentSessionCrumb(props);
  return html`
    <div class="chat-pane__crumbs">
      ${projectCrumb ? html`<div class="chat-pane__project-row">${projectCrumb}</div>` : nothing}
      <div class="chat-pane__session-trail">
        ${
          projectCrumb
            ? html`<span class="chat-pane__crumb-sep" aria-hidden="true">/</span>`
            : nothing
        }
        ${
          parentCrumb
            ? html`${parentCrumb}<span class="chat-pane__crumb-sep" aria-hidden="true">/</span>`
            : nothing
        }
        ${renderSessionCrumb(props)}
      </div>
    </div>
  `;
}

function renderParentSessionCrumb(props: ChatPaneHeaderProps): TemplateResult | null {
  const parent = props.parentSession;
  if (!parent) {
    return null;
  }
  const label = t("chat.sessionHeader.openParent", { title: parent.title });
  return html`<button
    class="chat-pane__parent-session"
    type="button"
    title=${label}
    aria-label=${label}
    @click=${() => props.onOpenParentSession(parent.key)}
  >
    <span class="chat-pane__parent-session-text">${parent.title}</span>
  </button>`;
}

function renderSessionCrumb(props: ChatPaneHeaderProps) {
  if (props.editing) {
    return html`<input
      class="chat-pane__session-title-input"
      .value=${props.renameValue}
      aria-label=${t("chat.sessionHeader.renameInputAria")}
      placeholder=${t("chat.sessionHeader.renameInputPlaceholder")}
      @input=${(event: InputEvent) =>
        props.onRenameInput((event.currentTarget as HTMLInputElement).value)}
      @compositionend=${recordCompositionEnd}
      @keyup=${clearCompositionEnd}
      @keydown=${(event: KeyboardEvent) => {
        if (isComposingKeyboardEvent(event)) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          props.onCommitRename();
        } else if (event.key === "Escape") {
          event.preventDefault();
          props.onCancelRename();
        }
      }}
      @blur=${(event: FocusEvent) => {
        clearCompositionEnd(event);
        props.onCommitRename();
      }}
    />`;
  }
  const title = html`${renderSessionColorDot(props.catalog ? props.catalogColor : props.session?.color)}<span
      class="chat-pane__session-title-text"
      >${props.title}</span
    >`;
  return props.catalog || !props.session || props.renameDisabledReason
    ? html`<span class="chat-pane__session-title" title=${props.renameDisabledReason ?? props.title}
        >${title}</span
      >`
    : html`<button
        class="chat-pane__session-title chat-pane__session-title-button"
        type="button"
        title=${t("chat.sessionHeader.renameTooltip")}
        aria-label=${t("chat.sessionHeader.renameAria", { title: props.title })}
        @click=${props.onBeginRename}
      >
        ${title}
      </button>`;
}

function renderProjectCrumb(props: ChatPaneHeaderProps): TemplateResult | null {
  if (props.catalog || !props.workspaceLabel) {
    return null;
  }
  const copyPathLabel =
    props.copiedAction === "copy-path"
      ? t("chat.sessionHeader.copied")
      : t("chat.sessionHeader.copyPath");
  const copyBranchLabel =
    props.copiedAction === "copy-branch"
      ? t("chat.sessionHeader.copied")
      : t("chat.sessionHeader.copyBranch");
  const copied = props.copiedAction === "copy-path" || props.copiedAction === "copy-branch";
  return html`
    <wa-dropdown
      class="chat-pane__workspace-menu"
      placement="bottom-start"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        const value = event.detail.item.value;
        if (value === "reveal" || value === "copy-path" || value === "copy-branch") {
          props.onMenuAction(value);
        }
      }}
      @wa-show=${() => props.onMenuOpenChange(true)}
      @wa-hide=${() => props.onMenuOpenChange(false)}
    >
      <button
        slot="trigger"
        class=${`chat-pane__workspace-chip${!copied && !props.workspaceIcon ? " chat-pane__workspace-chip--fallback-icon" : ""}`}
        type="button"
        title=${props.workspaceRoot ?? props.workspaceLabel}
        aria-label=${t("chat.sessionHeader.workspaceAria", {
          workspace: props.workspaceLabel,
        })}
      >
        ${copied ? icons.check : renderWorkspaceChipIcon(props.workspaceIcon)}<span
          >${copied ? t("chat.sessionHeader.copied") : props.workspaceLabel}</span
        >
      </button>
      ${[
        [props.canReveal && props.workspaceRoot, "reveal", revealLabel(props.platform)],
        [props.workspaceRoot, "copy-path", copyPathLabel],
        [props.branch, "copy-branch", copyBranchLabel],
      ].map(([visible, value, label]) =>
        visible ? html`<wa-dropdown-item value=${value}>${label}</wa-dropdown-item>` : nothing,
      )}
    </wa-dropdown>
  `;
}

function renderWorkspaceChipIcon(icon: ChatPaneHeaderProps["workspaceIcon"]) {
  return icon
    ? html`<openclaw-workspace-icon
        .routeUrl=${icon.routeUrl}
        .authTokens=${icon.authTokens}
        .authReady=${icon.authReady}
        .connectionId=${icon.connectionId}
      ></openclaw-workspace-icon>`
    : icons.folder;
}

export function canRevealSessionWorkspace(params: {
  session: GatewaySessionRow | undefined;
  workspaceRoot: string | null;
  methodAdvertised: boolean;
  hasAdminAccess: boolean;
}): boolean {
  return Boolean(
    params.workspaceRoot &&
    params.methodAdvertised &&
    params.hasAdminAccess &&
    !params.session?.execNode &&
    !isCloudWorkerPlacementState(params.session?.placement?.state),
  );
}

export function renderChatPaneHeader(props: ChatPaneHeaderProps) {
  const drawerLabel = props.navDrawerOpen ? t("nav.collapse") : t("nav.expand");
  const hasSharingControl = props.sharingControl !== undefined && props.sharingControl !== nothing;

  const runningSubagents =
    (props.runningSubagentCount ?? 0) > 0
      ? html`<span class="chat-pane__subagents-running"
          ><span aria-hidden="true">${icons.bot}</span>${t("chat.sessionHeader.subagentsRunning", {
            count: String(props.runningSubagentCount),
          })}</span
        >`
      : nothing;

  return html`
    <div
      class=${`chat-pane__header${props.onClosePane ? " chat-pane__header--closable" : ""}${props.narrow && runningSubagents !== nothing ? " chat-pane__header--stacked-status" : ""}`}
      role="group"
      aria-label=${props.title}
      tabindex="-1"
      @mousedown=${beginNativeWindowDrag}
    >
      <div class="chat-pane__header-leading">
        ${
          props.mergedChrome
            ? html`<openclaw-tooltip .content=${drawerLabel}>
                <button
                  class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle"
                  type="button"
                  aria-label=${drawerLabel}
                  aria-expanded=${String(Boolean(props.navDrawerOpen))}
                  @click=${(event: MouseEvent) => {
                    window.dispatchEvent(
                      new CustomEvent<ShellNavDrawerToggleDetail>(SHELL_NAV_DRAWER_TOGGLE_EVENT, {
                        detail: { trigger: event.currentTarget as HTMLElement },
                      }),
                    );
                  }}
                >
                  ${icons.menu}
                </button>
              </openclaw-tooltip>`
            : nothing
        }
        ${
          (props.incognito ?? props.session?.incognito)
            ? html`<span
                class="chat-pane__incognito"
                role="img"
                aria-label=${t("chat.sessionHeader.incognito")}
                title=${t("chat.sessionHeader.incognito")}
                >${icons.lock}</span
              >`
            : nothing
        }
        ${renderIdentityCrumbs(props)} ${props.publicAccessIndicator ?? nothing}
        ${
          hasSharingControl
            ? nothing
            : renderStandalonePersonLink(
                renderSessionOwnerChip(
                  props.showOwnerChip ? props.session?.owner?.actor : undefined,
                  "header",
                  props.session?.owner?.assignedAt !== undefined ? "owned" : "created",
                  props.ownerViewing,
                ),
                props.showOwnerChip
                  ? personActivityLink(
                      props.session?.owner?.actor.identity?.type === "profile"
                        ? props.session.owner.actor.identity.id
                        : undefined,
                      props.personActivity,
                      props.session?.owner?.actor.label,
                    )
                  : null,
              )
        }
        ${
          props.showOwnerChip && props.session?.participants?.length
            ? html`<openclaw-viewer-facepile
                class="chat-pane__participants"
                .staticParticipants=${props.session.participants}
                .totalCount=${props.session.participantCount}
                .maxVisible=${4}
                .personActivity=${props.personActivity}
                variant="session"
              ></openclaw-viewer-facepile>`
            : nothing
        }
        ${props.placementControl ?? nothing} ${props.presence ?? nothing}
      </div>
      <div class="chat-pane__header-trailing">
        ${props.detailsControl ?? nothing}
        <openclaw-chat-pane-versions-menu
          style="display: contents"
          .menu=${props}
        ></openclaw-chat-pane-versions-menu>
        <div class="chat-pane__actions">
          ${props.narrow ? nothing : runningSubagents} ${props.runAction ?? nothing}
          ${props.sharingControl ?? nothing} ${renderChatPaneLayoutMenu(props)}
          ${props.sessionMenuAction}
        </div>
      </div>
      ${props.narrow ? runningSubagents : nothing}
    </div>
  `;
}

function renderChatPaneLayoutMenu(props: ChatPaneHeaderProps) {
  const layout = props.sidebarLayout;
  const definitions = props.panelDefinitions ?? [];
  const side = layout ? sidebarActivePanel(layout) : undefined;
  const mainSlot = layout ? (sidebarMainPanel(layout)?.slot ?? "conversation") : "conversation";
  const mainDefinition = definitions.find((definition) => definition.slot === mainSlot);
  const sideDefinition = definitions.find((definition) => definition.slot === side?.slot);
  const split = layout?.open === true && !layout.expanded;
  const actions: (HeaderMenuQuickAction & {
    className?: string;
    shortcut?: KeyboardShortcutCombo;
  })[] = [];
  if (layout && props.onLayoutChange && (split || layout.expanded)) {
    actions.push({
      id: "focus",
      className: "chat-panel-focus",
      label: t(layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand"),
      icon: layout.expanded ? icons.minimize : icons.maximize,
      active: layout.expanded === true,
      onActivate: () =>
        props.onLayoutChange?.(
          setSidebarExpanded(ensureSidebarConversation(layout), layout.expanded !== true),
          { dashboardPresentation: "personal" },
        ),
    });
  }
  if (layout && props.onLayoutChange && split && side && mainDefinition && sideDefinition) {
    actions.push({
      id: "swap",
      className: "chat-panel-swap",
      label: t("chat.sidePanel.swap", { main: mainDefinition.label, side: sideDefinition.label }),
      icon: icons.arrowLeftRight,
      onActivate: () => props.onLayoutChange?.(promoteSidebarPanel(layout, side.id)),
    });
  }
  if (
    layout &&
    side &&
    sideDefinition &&
    !layout.expanded &&
    !props.narrow &&
    props.onLayoutChange
  ) {
    actions.push({
      id: "expand-side-panel",
      className: "side-panel__expand",
      label: t(
        layout.expanded && layout.expandedSide
          ? "chat.sidePanel.restore"
          : "chat.sidePanel.expandPanel",
        { panel: sideDefinition.label },
      ),
      icon: layout.expanded && layout.expandedSide ? icons.minimize : icons.maximize,
      onActivate: () =>
        props.onLayoutChange?.(toggleSidebarPanelExpanded(layout, side.id), {
          dashboardPresentation: "personal",
        }),
    });
  }
  if (side && sideDefinition && props.onCloseSidePanel) {
    actions.push({
      id: "close-side-panel",
      label: t("chat.sidebarColumns.close", { panel: sideDefinition.label }),
      icon: icons.x,
      onActivate: () => props.onCloseSidePanel?.(side.slot),
    });
  }
  if (props.onToggleSidePanel) {
    actions.push({
      id: "side-panel",
      className: "chat-side-panel-toggle",
      label: t(split ? "chat.sidePanel.minimize" : "chat.sidePanel.label"),
      icon: split ? icons.panelRightClose : icons.panelRightOpen,
      active: split,
      onActivate: props.onToggleSidePanel,
    });
  }
  actions.push(...(props.layoutMenuActions ?? []));
  for (const [id, label, icon, callback] of [
    ["open-split-view", "chat.splitView.open", icons.columns2, props.onOpenSplitView],
    ["split-down", "chat.splitView.splitDown", icons.panelBottomOpen, props.onSplitDown],
    ["split-right", "chat.splitView.splitRight", icons.panelRightOpen, props.onSplitRight],
    ["close-pane", "chat.splitView.closePane", icons.x, props.onClosePane],
  ] as const) {
    if (callback && (!props.narrow || (id !== "split-down" && id !== "split-right"))) {
      actions.push({
        id,
        label: t(label),
        className: id === "open-split-view" ? "chat-open-split-view" : `chat-pane__${id}`,
        icon,
        disabled: props.actionsDisabled,
        onActivate: () =>
          id === "open-split-view" ? props.onOpenSplitView?.() : callback(props.paneId),
      });
    }
  }
  if (layout && props.onLayoutChange && !props.narrow && split) {
    for (const [dock, label, icon] of [
      ["left", "dockLeft", icons.panelLeftOpen],
      ["right", "dockRight", icons.panelRightOpen],
      ["bottom", "dockBottom", icons.panelBottomOpen],
    ] as const) {
      actions.push({
        id: `dock-${dock}`,
        label: t(`chat.sidePanel.${label}`),
        icon,
        active: sidebarDock(layout) === dock,
        onActivate: () =>
          props.onLayoutChange?.(setSidebarDock(layout, dock), { geometryOnly: true }),
      });
    }
  }
  const panelActions = props.panelMenuActions ?? [];
  const allActions = [...actions, ...panelActions];
  if (allActions.length === 0 && !mainDefinition?.headerAction) {
    return nothing;
  }
  const renderAction = (action: (typeof actions)[number]) => {
    if (action.kind === "status") {
      return html`<div class="session-menu__status" data-menu-status=${action.id} role="note">
        <span class="session-menu__check" aria-hidden="true">${action.icon}</span>
        <span class="session-menu__text"
          >${action.label}${
            action.description
              ? html`<span class="session-menu__description">${action.description}</span>`
              : nothing
          }</span
        >
      </div>`;
    }
    return html`<wa-dropdown-item
      class=${`session-menu__item ${action.className ?? ""}`}
      value=${action.id}
      aria-label=${action.label}
      type=${action.active === undefined ? nothing : "checkbox"}
      .checked=${action.active ?? false}
      ?disabled=${action.disabled}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${action.icon}</span>
      <span class="session-menu__text"
        >${action.label}${
          action.description
            ? html`<span class="session-menu__description">${action.description}</span>`
            : nothing
        }</span
      >
      ${
        action.shortcut
          ? renderKeyboardShortcut(action.shortcut, {
              slot: "details",
              className: "side-panel-type-option__shortcut",
            })
          : nothing
      }
    </wa-dropdown-item>`;
  };
  return html`<wa-dropdown
    class="chat-pane__layout-menu chat-panel-layout-menu"
    placement="bottom-end"
    @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
      const action = allActions.find((candidate) => candidate.id === event.detail.item.value);
      if (event.currentTarget && action && action.kind !== "status" && !action.disabled) {
        event.preventDefault();
        // SAFETY: This wa-select listener is bound directly to this wa-dropdown instance.
        const menu = event.currentTarget as WaDropdown;
        pendingLayoutActions.set(menu, action.onActivate);
        // Opening and closing in one Lit update skips the hide event. Let the
        // opening update commit before asking Web Awesome to close.
        void menu.updateComplete.then(() => {
          menu.open = false;
          menu.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true });
        });
      }
    }}
    @wa-after-hide=${(event: Event) => {
      if (!event.currentTarget || event.target !== event.currentTarget) {
        return;
      }
      const action = pendingLayoutActions.get(event.currentTarget);
      pendingLayoutActions.delete(event.currentTarget);
      action?.();
    }}
  >
    <button
      slot="trigger"
      class="btn btn--ghost chat-pane__layout-trigger"
      type="button"
      aria-label=${t("chat.sessionHeader.layout")}
    >
      <span aria-hidden="true">${icons.columns2}</span>${t("chat.sessionHeader.layout")}
    </button>
    ${actions.map(renderAction)}
    ${
      panelActions.length
        ? html`<div class="session-menu__separator" role="separator"></div>
            ${panelActions.map(renderAction)}`
        : nothing
    }
    ${mainDefinition?.headerAction ?? nothing} ${sideDefinition?.headerAction ?? nothing}
  </wa-dropdown>`;
}

export function resolveChatPaneWorkspaceIcon(
  context: ApplicationContext,
  sessionKey: string | undefined,
) {
  if (!sessionKey) {
    return null;
  }
  const gateway = context.gateway;
  const authTokens = resolveControlUiAuthCandidates({
    hello: gateway.snapshot.hello,
    settings: { token: gateway.connection.token },
    password: gateway.connection.password,
  });
  return {
    routeUrl: buildControlUiResourcePath("workspaceIcon", context.resourceBasePath, sessionKey),
    authTokens,
    authReady: Boolean(gateway.snapshot.hello || authTokens.length),
    connectionId: gateway.snapshot.hello?.server?.connId,
  };
}
