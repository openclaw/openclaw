import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { buildControlUiResourcePath } from "../../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewaySessionRow, SessionBranch } from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../../app/control-ui-auth.ts";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import { icons } from "../../../components/icons.ts";
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
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
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
  type SidebarLayout,
} from "../sidebar-layout.ts";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";

export type ChatPaneHeaderAction = "reveal" | "copy-path" | "copy-branch";

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
  panelActions: TemplateResult | typeof nothing;
  runAction?: TemplateResult | typeof nothing;
  panelLayoutActions: TemplateResult | typeof nothing;
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

function renderIdentityCrumbs(
  props: ChatPaneHeaderProps,
  copied: boolean,
  copyPathLabel: string,
  copyBranchLabel: string,
) {
  const projectCrumb = renderProjectCrumb(props, copied, copyPathLabel, copyBranchLabel);
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

function renderProjectCrumb(
  props: ChatPaneHeaderProps,
  copied: boolean,
  copyPathLabel: string,
  copyBranchLabel: string,
): TemplateResult | null {
  if (props.catalog || !props.workspaceLabel) {
    return null;
  }
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
      ${
        props.canReveal && props.workspaceRoot
          ? html`<wa-dropdown-item value="reveal">${revealLabel(props.platform)}</wa-dropdown-item>`
          : nothing
      }
      ${
        props.workspaceRoot
          ? html`<wa-dropdown-item value="copy-path">${copyPathLabel}</wa-dropdown-item>`
          : nothing
      }
      ${
        props.branch
          ? html`<wa-dropdown-item value="copy-branch">${copyBranchLabel}</wa-dropdown-item>`
          : nothing
      }
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
  const copyPathLabel =
    props.copiedAction === "copy-path"
      ? t("chat.sessionHeader.copied")
      : t("chat.sessionHeader.copyPath");
  const copyBranchLabel =
    props.copiedAction === "copy-branch"
      ? t("chat.sessionHeader.copied")
      : t("chat.sessionHeader.copyBranch");
  const copied = props.copiedAction === "copy-path" || props.copiedAction === "copy-branch";
  const drawerLabel = props.navDrawerOpen ? t("nav.collapse") : t("nav.expand");
  const compactSessionActions = props.narrow && props.sessionMenuAction !== nothing;
  const hasSharingControl = props.sharingControl !== undefined && props.sharingControl !== nothing;

  return html`
    <div
      class=${`chat-pane__header${props.onClosePane ? " chat-pane__header--closable" : ""}`}
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
          props.session?.incognito
            ? html`<span
                class="chat-pane__incognito"
                role="img"
                aria-label=${t("chat.sessionHeader.incognito")}
                title=${t("chat.sessionHeader.incognito")}
                >${icons.lock}</span
              >`
            : nothing
        }
        ${renderIdentityCrumbs(props, copied, copyPathLabel, copyBranchLabel)}
        ${props.publicAccessIndicator ?? nothing}
        ${
          hasSharingControl
            ? props.sharingControl
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
        ${
          !props.catalog && props.branches.length > 1
            ? html`
                <wa-dropdown
                  class="chat-pane__branches-menu"
                  placement="bottom-end"
                  @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                    const leafEntryId = event.detail.item.value;
                    const branch = props.branches.find(
                      (candidate) => candidate.leafEntryId === leafEntryId,
                    );
                    if (
                      leafEntryId &&
                      branch &&
                      !branch.active &&
                      !props.branchSwitchDisabledReason
                    ) {
                      props.onBranchSelect(leafEntryId);
                    }
                  }}
                >
                  <button
                    slot="trigger"
                    class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
                    type="button"
                    ?disabled=${Boolean(props.branchSwitchDisabledReason)}
                    title=${props.branchSwitchDisabledReason ?? t("chat.sessionHeader.branches")}
                    aria-label=${t("chat.sessionHeader.branches")}
                  >
                    ${icons.gitBranch}
                  </button>
                  ${props.branches.map((branch) => {
                    const updatedAt = Date.parse(branch.updatedAt ?? "");
                    const relativeTime = formatRelativeTimestamp(updatedAt, { fallback: "" });
                    return html`
                      <wa-dropdown-item
                        class="chat-pane__branch-item"
                        value=${branch.leafEntryId}
                        ?disabled=${branch.active || Boolean(props.branchSwitchDisabledReason)}
                        data-active=${branch.active ? "true" : "false"}
                      >
                        <span class="chat-pane__branch-copy">
                          <span class="chat-pane__branch-headline"
                            >${branch.headline || t("chat.sessionHeader.untitledBranch")}</span
                          >
                          <span class="chat-pane__branch-meta"
                            >${t(
                              branch.messageCount === 1
                                ? "chat.sessionHeader.oneMessage"
                                : "chat.sessionHeader.messages",
                              { count: String(branch.messageCount) },
                            )}${relativeTime ? ` · ${relativeTime}` : ""}</span
                          >
                        </span>
                        ${
                          branch.active
                            ? html`<span
                                class="chat-pane__branch-active"
                                aria-label=${t("chat.sessionHeader.activeBranch")}
                                >${icons.check}</span
                              >`
                            : nothing
                        }
                      </wa-dropdown-item>
                    `;
                  })}
                </wa-dropdown>
              `
            : nothing
        }
        <div class="chat-pane__actions">
          ${props.runAction ?? nothing} ${props.panelLayoutActions}
          <fieldset class="chat-pane__actions" ?disabled=${props.actionsDisabled}>
            ${compactSessionActions ? nothing : props.panelActions}
            ${(
              [
                [
                  props.onOpenSplitView && !compactSessionActions,
                  "chat-open-split-view",
                  "chat.splitView.open",
                  icons.columns2,
                  props.onOpenSplitView,
                ],
                [
                  !props.narrow && props.onSplitDown,
                  "chat-pane__split-down",
                  "chat.splitView.splitDown",
                  icons.panelBottomOpen,
                  () => props.onSplitDown?.(props.paneId),
                ],
                [
                  !props.narrow && props.onSplitRight,
                  "chat-pane__split-right",
                  "chat.splitView.splitRight",
                  icons.panelRightOpen,
                  () => props.onSplitRight?.(props.paneId),
                ],
                [
                  props.onClosePane,
                  "chat-pane__close-pane",
                  "chat.splitView.closePane",
                  icons.x,
                  () => props.onClosePane?.(props.paneId),
                ],
                [
                  props.mergedChrome && !compactSessionActions,
                  "chat-pane__palette-open",
                  "chat.openCommandPalette",
                  icons.search,
                  () => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT)),
                ],
              ] as const
            ).map(([visible, className, label, icon, onClick]) =>
              visible
                ? html`<openclaw-tooltip .content=${t(label)}>
                    <button
                      class=${`btn btn--ghost btn--icon chat-icon-btn ${className}`}
                      type="button"
                      aria-label=${t(label)}
                      @click=${onClick}
                    >
                      ${icon}
                    </button>
                  </openclaw-tooltip>`
                : nothing,
            )}
            ${props.sessionMenuAction}
          </fieldset>
        </div>
      </div>
    </div>
  `;
}

export function renderChatPanePanelToggle(props: {
  label: string;
  icon: TemplateResult;
  className?: string;
  expanded?: boolean;
  onToggle: () => void;
}) {
  return html`<openclaw-tooltip .content=${props.label}>
    <button
      class="btn btn--ghost btn--icon chat-icon-btn ${props.className ?? ""}"
      type="button"
      aria-label=${props.label}
      aria-expanded=${ifDefined(props.expanded === undefined ? undefined : String(props.expanded))}
      @click=${props.onToggle}
    >
      ${props.icon}
    </button>
  </openclaw-tooltip>`;
}

export function renderChatPanePanelLayoutActions(
  layout: SidebarLayout | undefined,
  definitions: SidebarPanelDefinition[],
  narrow: boolean,
  onLayoutChange: ChatPageHost["updateSidebarLayout"],
) {
  if (!layout) {
    return nothing;
  }
  const side = sidebarActivePanel(layout);
  const mainSlot = sidebarMainPanel(layout)?.slot ?? "conversation";
  const mainDefinition = definitions.find((definition) => definition.slot === mainSlot);
  const sideDefinition = definitions.find((definition) => definition.slot === side?.slot);
  const split = layout.open === true && !layout.expanded;
  const focusLabel = t(layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand");
  const swapLabel =
    mainDefinition && sideDefinition
      ? t("chat.sidePanel.swap", { main: mainDefinition.label, side: sideDefinition.label })
      : "";
  return html`${
    mainDefinition?.headerAction
      ? html`<span class="side-panel__action-group side-panel__action-group--content"
          >${mainDefinition.headerAction}</span
        >`
      : nothing
  }
  ${
    split || layout.expanded
      ? html`<openclaw-tooltip .content=${focusLabel}>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-panel-focus"
            type="button"
            aria-pressed=${String(layout.expanded === true)}
            aria-label=${focusLabel}
            @click=${() =>
              onLayoutChange(
                setSidebarExpanded(ensureSidebarConversation(layout), layout.expanded !== true),
                { dashboardPresentation: "personal" },
              )}
          >
            ${layout.expanded ? icons.minimize : icons.maximize}
          </button>
        </openclaw-tooltip>`
      : nothing
  }
  ${
    split && side && swapLabel
      ? html`<openclaw-tooltip .content=${swapLabel}>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-panel-swap"
            type="button"
            aria-label=${swapLabel}
            @click=${() => onLayoutChange(promoteSidebarPanel(layout, side.id))}
          >
            ${icons.arrowLeftRight}
          </button>
        </openclaw-tooltip>`
      : nothing
  }
  ${
    narrow || !split
      ? nothing
      : html`<wa-dropdown
          class="chat-panel-layout-menu"
          placement="bottom-end"
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            const dock = event.detail.item.value;
            if (dock === "left" || dock === "right" || dock === "bottom") {
              onLayoutChange(setSidebarDock(layout, dock), {
                geometryOnly: true,
              });
            }
          }}
        >
          <button
            slot="trigger"
            class="btn btn--ghost btn--icon chat-icon-btn"
            type="button"
            aria-label=${t("chat.sidePanel.layout")}
            title=${t("chat.sidePanel.layout")}
          >
            ${icons.columns2}
          </button>
          ${(
            [
              ["left", "dockLeft", icons.panelLeftOpen],
              ["right", "dockRight", icons.panelRightOpen],
              ["bottom", "dockBottom", icons.panelBottomOpen],
            ] as const
          ).map(
            ([dock, label, icon]) => html`<wa-dropdown-item
              value=${dock}
              type="checkbox"
              ?checked=${sidebarDock(layout) === dock}
              ><span slot="icon">${icon}</span>${t(`chat.sidePanel.${label}`)}</wa-dropdown-item
            >`,
          )}
        </wa-dropdown>`
  }`;
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
