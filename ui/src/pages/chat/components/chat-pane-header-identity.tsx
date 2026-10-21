import { Show, createMemo, onSettled } from "solid-js";
import { buildControlUiResourcePath } from "../../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../../app/control-ui-auth.ts";
import { SessionColorDot } from "../../../components/session-color.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { GatewayStatus } from "../../../components/solid/gateway-status.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../../../components/solid/identity-avatar.tsx";
import { Menu, type MenuItem } from "../../../components/solid/menu.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { SessionTitlePlaceholder } from "../../../components/solid/session-title-placeholder.tsx";
import "../../../components/workspace-icon.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { isSessionTitlePending, resolveSessionDisplayName } from "../../../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
} from "../../../lib/sessions/session-key.ts";
import { nativeListener } from "../../../lib/solid-native-listener.ts";
import type { ChatPaneHeaderProps, ChatPaneParentSession } from "./chat-pane-header.types.ts";

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

function CrumbSeparator(props: { merged: boolean }) {
  return (
    <span class="chat-pane__crumb-sep" aria-hidden="true">
      {props.merged ? (
        "/"
      ) : (
        <svg width="4" height="20" viewBox="0 0 4 20" fill="none">
          <path
            d="M3.3 4.7.7 15.3"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      )}
    </span>
  );
}

export function IdentityCrumbs(props: ChatPaneHeaderProps) {
  const hasProject = () => !props.catalog && Boolean(props.workspaceLabel);
  const status = () =>
    props.mergedChrome && props.gatewayStatus?.kind !== "connected" && props.gatewayStatus?.kind;
  return (
    <div class="chat-pane__crumbs">
      <Show when={hasProject() || status()}>
        <div class="chat-pane__project-row">
          <Show when={status()} fallback={<ProjectCrumb {...props} />}>
            <div class="mobile-connection-status">
              <GatewayStatus {...props.gatewayStatus!} />
            </div>
          </Show>
        </div>
      </Show>
      <div class="chat-pane__session-trail">
        <Show when={hasProject()}>
          <CrumbSeparator merged={props.mergedChrome} />
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
              <CrumbSeparator merged={props.mergedChrome} />
            </>
          )}
        </Show>
        <SessionCrumb {...props} />
      </div>
    </div>
  );
}

// Roster mode keeps the session crumbs off the agent pill: it is one settings target.
export function AgentCrumb(
  props: ChatPaneHeaderProps & { agent: NonNullable<ChatPaneHeaderProps["agent"]> },
) {
  return (
    <button
      class="chat-pane__agent-identity"
      type="button"
      aria-label={t("agentChip.namedSettings", { name: props.agent.name })}
      onClick={() => props.onOpenAgentSettings?.(props.agent.id)}
    >
      <span class="chat-pane__agent-avatar" aria-hidden="true">
        <AgentIdentityAvatar agent={props.agent} />
      </span>
      <span class="chat-pane__agent-name">{props.agent.name}</span>
      <span class="chat-pane__agent-settings" aria-hidden="true">
        <Icon name="settings" />
      </span>
    </button>
  );
}

function SessionTitle(props: ChatPaneHeaderProps) {
  return (
    <>
      <SessionColorDot value={props.catalog ? props.catalogColor : props.session?.color} />
      <span class="chat-pane__session-title-text">
        <Show
          when={
            props.titlePending ??
            (!props.catalog && isSessionTitlePending(props.session?.key ?? "", props.session))
          }
          fallback={props.title}
        >
          <SessionTitlePlaceholder />
        </Show>
      </span>
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
              onClick={() => props.onBeginRename()}
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
      <SessionRenameInput {...props} />
    </Show>
  );
}

function SessionRenameInput(props: ChatPaneHeaderProps) {
  let input!: HTMLInputElement;
  onSettled(() => {
    input.focus();
    input.select();
  });
  return (
    <input
      class="chat-pane__session-title-input"
      value={props.renameValue}
      aria-label={t("chat.sessionHeader.renameInputAria")}
      placeholder={t("chat.sessionHeader.renameInputPlaceholder")}
      onInput={(event) => props.onRenameInput(event.currentTarget.value)}
      onCompositionEnd={recordCompositionEnd}
      ref={[(element) => (input = element), nativeListener("keyup", clearCompositionEnd)]}
      onKeyDown={(event) => {
        if (isComposingKeyboardEvent(event)) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (!props.renameDisabledReason) {
            props.onCommitRename();
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          props.onCancelRename();
        }
      }}
      onBlur={(event) => {
        clearCompositionEnd(event);
        if (!props.renameDisabledReason) {
          props.onCommitRename();
        }
      }}
    />
  );
}

let nextWorkspaceMenuId = 0;

export function ProjectCrumb(props: ChatPaneHeaderProps) {
  const overflow = useScrollState(true, false);
  const id = `chat-workspace-${++nextWorkspaceMenuId}`;
  const copied = () => props.copiedAction === "copy-path" || props.copiedAction === "copy-branch";
  const items = createMemo(() => {
    const copyActions: MenuItem[] = (
      [
        ["copy-path", "listTree", props.workspaceRoot, "chat.sessionHeader.copyPath"],
        ["copy-branch", "gitBranch", props.branch, "chat.sessionHeader.copyBranch"],
      ] as const
    ).flatMap(([action, icon, value, label]) =>
      value
        ? [
            {
              id: action,
              icon: (
                <span class="session-menu__icon" aria-hidden="true">
                  <Icon name={icon} />
                </span>
              ),
              label: t(props.copiedAction === action ? "chat.sessionHeader.copied" : label),
              details: (
                <span class="session-menu__icon" aria-hidden="true">
                  <Icon name="copy" />
                </span>
              ),
            },
          ]
        : [],
    );
    return [
      ...copyActions,
      ...(props.canReveal && props.workspaceRoot
        ? [
            {
              kind: "content" as const,
              id: "reveal-separator",
              content: <div class="session-menu__separator" role="separator" />,
            },
            {
              id: "reveal",
              icon: (
                <span class="session-menu__icon" aria-hidden="true">
                  <Icon name="folder" />
                </span>
              ),
              label: revealLabel(props.platform),
            },
          ]
        : []),
    ];
  });
  return (
    <Menu
      lazy
      id={id}
      class="chat-pane__workspace-menu"
      placement="bottom-start"
      label={t("chat.sessionHeader.workspaceAria", { workspace: props.workspaceLabel ?? "" })}
      triggerClass={`chat-pane__workspace-chip${!copied() && !props.workspaceIcon ? " chat-pane__workspace-chip--fallback-icon" : ""}`}
      triggerAttributes={{
        title: props.mergedChrome
          ? undefined
          : (props.workspaceRoot ?? props.workspaceLabel ?? undefined),
      }}
      items={items()}
      onSelect={(item) => {
        if (item.id === "reveal" || item.id === "copy-path" || item.id === "copy-branch") {
          props.onMenuAction(item.id);
        }
      }}
      onOpenChange={props.onMenuOpenChange}
      trigger={
        <>
          <Show when={!props.mergedChrome}>
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
          </Show>
          <span ref={overflow}>
            {copied() ? t("chat.sessionHeader.copied") : props.workspaceLabel}
          </span>
        </>
      }
    />
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
