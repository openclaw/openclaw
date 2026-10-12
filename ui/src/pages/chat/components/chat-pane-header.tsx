import { Show } from "solid-js";
import { buildControlUiResourcePath } from "../../../../../src/gateway/control-ui-resource-routes.js";
import { isIncognitoSessionKey } from "../../../../../src/shared/incognito-session-key.js";
import type { GatewaySessionRow, SessionBranch } from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../../app/control-ui-auth.ts";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import {
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
import "../../../components/tooltip.ts";
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
import { presentedContent, type PresentationValue } from "../../../lit/presentation-binding.ts";
import { LitContent, solidContent, emptyLegacyContent } from "../../../lit/solid-content.tsx";
import { ChatPaneLayoutMenu, type ChatPaneLayoutMenuProps } from "./chat-header-panel-actions.tsx";
import { ChatPaneVersionsMenu } from "./chat-pane-versions-menu.tsx";

export type ChatPaneHeaderAction = "reveal" | "copy-path" | "copy-branch";

type ChatPaneParentSession = {
  key: string;
  title: string;
};

export type ChatPaneHeaderProps = ChatPaneLayoutMenuProps & {
  presented: PresentationValue;
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
  runningSubagentCount?: number;
  detailsControl?: unknown;
  runAction?: unknown;
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
  const hasSharingControl = () =>
    props.sharingControl !== undefined && props.sharingControl !== emptyLegacyContent;
  const incognito = () =>
    (props.incognito ?? props.session?.incognito) || isIncognitoSessionKey(props.session?.key);

  return (
    <>
      <div
        class={[
          "chat-pane__header",
          {
            "chat-pane__header--closable": props.onClosePane !== undefined,
            "chat-pane__header--stacked-status":
              props.narrow && (props.runningSubagentCount ?? 0) > 0,
          },
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
          <Show when={incognito()}>
            <openclaw-tooltip
              prop:content={t("sessionsView.incognitoDescription")}
              placement="bottom"
              prop:openOnClick={true}
            >
              <button type="button" class="chat-pane__incognito">
                <span aria-hidden="true">
                  <Icon name="incognito" />
                </span>
                {t("sessionsView.incognitoLabel")}
              </button>
            </openclaw-tooltip>
          </Show>
          <IdentityCrumbs {...props} /> <LitContent value={props.publicAccessIndicator} />
          {hasSharingControl() ? undefined : (
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
          <LitContent
            value={presentedContent(
              props.presented,
              solidContent(ChatPaneVersionsMenu, {
                menu: {
                  catalog: props.catalog,
                  branches: props.branches,
                  branchSwitchDisabledReason: props.branchSwitchDisabledReason,
                  onBranchSelect: props.onBranchSelect,
                },
              }),
            )}
          />
          <div class="chat-pane__actions">
            <Show when={!props.narrow}>
              <RunningSubagents count={props.runningSubagentCount} />
            </Show>
            <LitContent value={props.runAction} />
            <LitContent value={props.sharingControl} />
            <ChatPaneLayoutMenu {...props} />
            <LitContent value={props.sessionMenuAction} />
          </div>
        </div>
        <Show when={props.narrow}>
          <RunningSubagents count={props.runningSubagentCount} />
        </Show>
      </div>
      <Show when={incognito()}>
        <aside class="chat-pane__incognito-notice" aria-label={t("sessionsView.incognitoLabel")}>
          <span class="chat-pane__incognito-notice-icon" aria-hidden="true">
            <Icon name="incognito" />
          </span>
          <div>
            <p>{t("sessionsView.incognitoDescription")}</p>
            <p class="chat-pane__incognito-limits">{t("sessionsView.incognitoLimits")}</p>
          </div>
        </aside>
      </Show>
    </>
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

function RunningSubagents(props: { count?: number }) {
  return (
    <Show when={(props.count ?? 0) > 0}>
      <span class="chat-pane__subagents-running">
        <span aria-hidden="true">
          <Icon name="bot" />
        </span>
        {t("chat.sessionHeader.subagentsRunning", { count: String(props.count) })}
      </span>
    </Show>
  );
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
