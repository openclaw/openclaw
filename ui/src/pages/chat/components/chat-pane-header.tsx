import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { For, Show } from "solid-js";
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
import {
  personActivityLink,
  renderStandalonePersonLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { renderSessionColorDot } from "../../../components/session-color.ts";
import { renderSessionOwnerChip } from "../../../components/session-owner-chip.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { syncPopoverExpanded, syncPopoverLabel } from "../../../components/web-awesome-popover.ts";
import "../../../components/tooltip.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import "../../../components/workspace-icon.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
import { i18nRevision, t } from "../../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
} from "../../../lib/sessions/session-key.ts";
import { nativeListener } from "../../../lib/solid-native-listener.ts";
import { LitContent, solidContent, emptyLegacyContent } from "../../../lit/solid-content.tsx";
import { ChatPanePanelToggle } from "./chat-header-panel-actions.tsx";
export {
  ChatPanePanelToggle,
  ChatPanePanelLayoutActions,
  renderChatPanePanelToggle,
  renderChatPanePanelLayoutActions,
} from "./chat-header-panel-actions.tsx";

export type ChatPaneHeaderAction = "reveal" | "copy-path" | "copy-branch";

type ChatPaneParentSession = {
  key: string;
  title: string;
};

export type ChatPaneHeaderProps = {
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
  panelActions: unknown;
  detailsControl?: unknown;
  runAction?: unknown;
  panelLayoutActions: unknown;
  presence?: unknown;
  sharingControl?: unknown;
  publicAccessIndicator?: unknown;
  placementControl?: unknown;
  sessionMenuAction: unknown;
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

function IdentityCrumbs(props: ChatPaneHeaderProps) {
  const hasProject = () => !props.catalog && Boolean(props.workspaceLabel);
  return (
    <div class="chat-pane__crumbs">
      <Show when={hasProject()}>
        <div class="chat-pane__project-row">
          <ProjectCrumb {...props} />
        </div>
      </Show>
      <div class="chat-pane__session-trail">
        <Show when={hasProject()}>
          <span class="chat-pane__crumb-sep" aria-hidden="true">
            /
          </span>
        </Show>
        <Show when={props.parentSession}>
          {(parent) => (
            <>
              <button
                class="chat-pane__parent-session"
                type="button"
                title={t("chat.sessionHeader.openParent", { title: parent().title })}
                aria-label={t("chat.sessionHeader.openParent", { title: parent().title })}
                onClick={() => props.onOpenParentSession(parent().key)}
              >
                <span class="chat-pane__parent-session-text">{parent().title}</span>
              </button>
              <span class="chat-pane__crumb-sep" aria-hidden="true">
                /
              </span>
            </>
          )}
        </Show>
        <SessionCrumb {...props} />
      </div>
    </div>
  );
}

function SessionTitle(props: ChatPaneHeaderProps) {
  return (
    <>
      <LitContent
        value={
          (i18nRevision(),
          renderSessionColorDot(props.catalog ? props.catalogColor : props.session?.color))
        }
      />
      <span class="chat-pane__session-title-text">{props.title}</span>
    </>
  );
}

function SessionCrumb(props: ChatPaneHeaderProps) {
  return (
    <Show
      when={props.editing}
      fallback={
        <Show
          when={Boolean(props.catalog || !props.session || props.renameDisabledReason)}
          fallback={
            <button
              class="chat-pane__session-title chat-pane__session-title-button"
              type="button"
              title={t("chat.sessionHeader.renameTooltip")}
              aria-label={t("chat.sessionHeader.renameAria", { title: props.title })}
              onClick={props.onBeginRename}
            >
              <SessionTitle {...props} />
            </button>
          }
        >
          <span class="chat-pane__session-title" title={props.renameDisabledReason ?? props.title}>
            <SessionTitle {...props} />
          </span>
        </Show>
      }
    >
      <input
        class="chat-pane__session-title-input"
        value={props.renameValue}
        aria-label={t("chat.sessionHeader.renameInputAria")}
        placeholder={t("chat.sessionHeader.renameInputPlaceholder")}
        onInput={(event) => props.onRenameInput(event.currentTarget.value)}
        onCompositionEnd={recordCompositionEnd}
        ref={nativeListener("keyup", clearCompositionEnd)}
        onKeyDown={(event) => {
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
        onBlur={(event) => {
          clearCompositionEnd(event);
          props.onCommitRename();
        }}
      />
    </Show>
  );
}

function ProjectCrumb(props: ChatPaneHeaderProps) {
  const copied = () => props.copiedAction === "copy-path" || props.copiedAction === "copy-branch";
  return (
    <wa-dropdown
      class="chat-pane__workspace-menu"
      placement="bottom-start"
      onWa-select={(event) => {
        const value = event.detail.item.value;
        if (value === "reveal" || value === "copy-path" || value === "copy-branch") {
          props.onMenuAction(value);
        }
      }}
      onWa-show={() => props.onMenuOpenChange(true)}
      onWa-hide={() => props.onMenuOpenChange(false)}
    >
      <button
        slot="trigger"
        class={[
          "chat-pane__workspace-chip",
          { "chat-pane__workspace-chip--fallback-icon": !copied() && !props.workspaceIcon },
        ]}
        type="button"
        title={props.workspaceRoot ?? props.workspaceLabel ?? undefined}
        aria-label={t("chat.sessionHeader.workspaceAria", {
          workspace: props.workspaceLabel ?? "",
        })}
      >
        <Show
          when={copied()}
          fallback={
            <Show when={Boolean(props.workspaceIcon)} fallback={<Icon name="folder" />}>
              <openclaw-workspace-icon
                prop:routeUrl={props.workspaceIcon!.routeUrl}
                prop:authTokens={props.workspaceIcon!.authTokens}
                prop:authReady={props.workspaceIcon!.authReady}
                prop:connectionId={props.workspaceIcon!.connectionId}
              />
            </Show>
          }
        >
          <Icon name="check" />
        </Show>
        <span>{copied() ? t("chat.sessionHeader.copied") : props.workspaceLabel}</span>
      </button>
      <Show when={props.canReveal && props.workspaceRoot}>
        <wa-dropdown-item value="reveal">{revealLabel(props.platform)}</wa-dropdown-item>
      </Show>
      <Show when={props.workspaceRoot}>
        <wa-dropdown-item value="copy-path">
          {t(
            props.copiedAction === "copy-path"
              ? "chat.sessionHeader.copied"
              : "chat.sessionHeader.copyPath",
          )}
        </wa-dropdown-item>
      </Show>
      <Show when={props.branch}>
        <wa-dropdown-item value="copy-branch">
          {t(
            props.copiedAction === "copy-branch"
              ? "chat.sessionHeader.copied"
              : "chat.sessionHeader.copyBranch",
          )}
        </wa-dropdown-item>
      </Show>
    </wa-dropdown>
  );
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

export function ChatPaneHeader(props: ChatPaneHeaderProps) {
  const drawerLabel = () => (props.navDrawerOpen ? t("nav.collapse") : t("nav.expand"));
  const compactSessionActions = () =>
    props.narrow && props.sessionMenuAction !== emptyLegacyContent;
  const hasSharingControl = () =>
    props.sharingControl !== undefined && props.sharingControl !== emptyLegacyContent;

  return (
    <div
      class={[
        "chat-pane__header",
        { "chat-pane__header--closable": props.onClosePane !== undefined },
      ]}
      role="group"
      aria-label={props.title}
      tabindex={-1}
      onMouseDown={beginNativeWindowDrag}
    >
      <div class="chat-pane__header-leading">
        {props.mergedChrome ? (
          <openclaw-tooltip prop:content={drawerLabel()}>
            <button
              class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle"
              type="button"
              aria-label={drawerLabel()}
              aria-expanded={props.navDrawerOpen ? "true" : "false"}
              onClick={(event) => {
                window.dispatchEvent(
                  new CustomEvent<ShellNavDrawerToggleDetail>(SHELL_NAV_DRAWER_TOGGLE_EVENT, {
                    detail: {
                      trigger: event.currentTarget,
                    },
                  }),
                );
              }}
            >
              <Icon name="menu" />
            </button>
          </openclaw-tooltip>
        ) : undefined}
        {(props.incognito ?? props.session?.incognito) ? (
          <span
            class="chat-pane__incognito"
            role="img"
            aria-label={t("chat.sessionHeader.incognito")}
            title={t("chat.sessionHeader.incognito")}
          >
            <Icon name="lock" />
          </span>
        ) : undefined}
        <IdentityCrumbs {...props} /> <LitContent value={props.publicAccessIndicator} />
        {hasSharingControl() ? (
          <LitContent value={props.sharingControl} />
        ) : (
          <LitContent
            value={renderStandalonePersonLink(
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
            )}
          />
        )}
        {props.showOwnerChip && props.session?.participants?.length ? (
          <openclaw-viewer-facepile
            class="chat-pane__participants"
            prop:staticParticipants={props.session.participants}
            prop:totalCount={props.session.participantCount}
            prop:maxVisible={4}
            prop:personActivity={props.personActivity}
            variant="session"
          />
        ) : undefined}
        <LitContent value={props.placementControl} /> <LitContent value={props.presence} />
      </div>
      <div class="chat-pane__header-trailing">
        <LitContent value={props.detailsControl} />
        {!props.catalog && props.branches.length > 1 ? (
          <wa-dropdown
            class="chat-pane__branches-menu"
            placement="bottom-end"
            onWa-hide={(event: Event) => {
              const menu = event.currentTarget;
              if (event.target === menu && menu instanceof HTMLElement) {
                const help = menu.querySelector<WaPopover>(".chat-pane__versions-help");
                if (help) {
                  help.open = false;
                }
              }
            }}
            onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
              const leafEntryId = event.detail.item.value;
              const branch = props.branches.find(
                (candidate) => candidate.leafEntryId === leafEntryId,
              );
              if (leafEntryId && branch && !branch.active && !props.branchSwitchDisabledReason) {
                props.onBranchSelect(leafEntryId);
              }
            }}
          >
            <button
              slot="trigger"
              class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
              type="button"
              disabled={Boolean(props.branchSwitchDisabledReason)}
              title={props.branchSwitchDisabledReason ?? t("chat.sessionHeader.branches")}
              aria-label={t("chat.sessionHeader.branches")}
            >
              <Icon name="history" />
            </button>
            <div class="chat-pane__versions-heading">
              <span>{t("chat.sessionHeader.branches")}</span>
              <button
                id={`versions-help-${props.paneId}`}
                class="btn btn--ghost btn--icon chat-pane__versions-info"
                type="button"
                autofocus
                aria-label={t("chat.sessionHeader.versionsHelpLabel")}
                aria-haspopup="dialog"
                aria-expanded="false"
                aria-controls={`versions-help-content-${props.paneId}`}
              >
                <Icon name="info" />
              </button>
              <wa-popover
                ref={syncPopoverLabel}
                id={`versions-help-content-${props.paneId}`}
                class="chat-pane__versions-help"
                for={`versions-help-${props.paneId}`}
                aria-label={t("chat.sessionHeader.versionsHelpLabel")}
                placement="bottom-end"
                onWa-show={syncPopoverExpanded}
                onWa-hide={syncPopoverExpanded}
              >
                {t("chat.sessionHeader.versionsHelp")}
              </wa-popover>
            </div>
            <For each={props.branches} keyed={(branch) => branch.leafEntryId}>
              {(branch) => {
                const relativeTime = () =>
                  formatRelativeTimestamp(Date.parse(branch().updatedAt ?? ""), { fallback: "" });
                return (
                  <wa-dropdown-item
                    class="chat-pane__branch-item"
                    value={branch().leafEntryId}
                    disabled={branch().active || Boolean(props.branchSwitchDisabledReason)}
                    data-active={branch().active ? "true" : "false"}
                  >
                    <span class="chat-pane__branch-copy">
                      <span class="chat-pane__branch-headline">
                        {branch().headline || t("chat.sessionHeader.untitledBranch")}
                      </span>
                      <span class="chat-pane__branch-meta">
                        {t(
                          branch().messageCount === 1
                            ? "chat.sessionHeader.oneMessage"
                            : "chat.sessionHeader.messages",
                          { count: String(branch().messageCount) },
                        )}
                        {relativeTime() ? ` · ${relativeTime()}` : ""}
                      </span>
                    </span>
                    {branch().active ? (
                      <span
                        slot="details"
                        class="chat-pane__branch-active"
                        aria-label={t("chat.sessionHeader.activeBranch")}
                      >
                        <Icon name="check" />
                      </span>
                    ) : undefined}
                  </wa-dropdown-item>
                );
              }}
            </For>
          </wa-dropdown>
        ) : undefined}
        <div class="chat-pane__actions">
          <LitContent value={props.runAction} /> <LitContent value={props.panelLayoutActions} />
          <fieldset class="chat-pane__actions" disabled={Boolean(props.actionsDisabled)}>
            {compactSessionActions() ? undefined : <LitContent value={props.panelActions} />}
            <Show when={props.onOpenSplitView !== undefined && !compactSessionActions()}>
              <ChatPanePanelToggle
                class="chat-open-split-view"
                label={t("chat.splitView.open")}
                icon={<Icon name="columns2" />}
                onToggle={() => props.onOpenSplitView?.()}
              />
            </Show>
            <Show when={!props.narrow && props.onSplitDown !== undefined}>
              <ChatPanePanelToggle
                class="chat-pane__split-down"
                label={t("chat.splitView.splitDown")}
                icon={<Icon name="panelBottomOpen" />}
                onToggle={() => props.onSplitDown?.(props.paneId)}
              />
            </Show>
            <Show when={!props.narrow && props.onSplitRight !== undefined}>
              <ChatPanePanelToggle
                class="chat-pane__split-right"
                label={t("chat.splitView.splitRight")}
                icon={<Icon name="panelRightOpen" />}
                onToggle={() => props.onSplitRight?.(props.paneId)}
              />
            </Show>
            <Show when={props.onClosePane !== undefined}>
              <ChatPanePanelToggle
                class="chat-pane__close-pane"
                label={t("chat.splitView.closePane")}
                icon={<Icon name="x" />}
                onToggle={() => props.onClosePane?.(props.paneId)}
              />
            </Show>
            <Show when={props.mergedChrome && !compactSessionActions()}>
              <ChatPanePanelToggle
                class="chat-pane__palette-open"
                label={t("chat.openCommandPalette")}
                icon={<Icon name="search" />}
                onToggle={() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
              />
            </Show>
            <LitContent value={props.sessionMenuAction} />
          </fieldset>
        </div>
      </div>
    </div>
  );
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

export const renderChatPaneHeader = (props: ChatPaneHeaderProps) =>
  solidContent(ChatPaneHeader, props);
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-workspace-icon": HTMLAttributes<HTMLElement> & {
        "prop:routeUrl": string;
        "prop:authTokens": readonly string[];
        "prop:authReady": boolean;
        "prop:connectionId"?: string;
      };
    }
  }
}
