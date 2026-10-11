import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createMemo } from "solid-js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isMobileNavLayout } from "../../app/mobile-nav-layout.ts";
import { resolveSidebarSessionParentKey } from "../../components/app-sidebar-session-parent.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import { hasSessionArchiveDescendants } from "../../components/session-menu-descendants.ts";
import type { SessionMenuAction, SessionMenuWork } from "../../components/session-menu.ts";
import { openEditor } from "../../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  isPinnableUiSessionRow,
  isSubagentSessionKey,
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import {
  canCopySessionMarkdown,
  runSessionNavigationAction,
} from "../../lib/sessions/session-menu-navigation.ts";
import { pluginSessionMenuActions } from "../../plugins/control-ui-actions.ts";

type SessionMenuElement = HTMLElementTagNameMap["openclaw-session-menu"];
type SessionMenuProperties = Pick<
  SessionMenuElement,
  | "session"
  | "compact"
  | "anchor"
  | "trigger"
  | "disabled"
  | "navigationAllowed"
  | "copyMarkdownAllowed"
  | "splitAllowed"
  | "actionDisabledReasons"
  | "forkDisabled"
  | "forkFromLastCompleted"
  | "archiveAllowed"
  | "deleteAllowed"
  | "cloudWorkerStopAllowed"
  | "groups"
  | "currentOwner"
  | "work"
  | "pluginActions"
  | "onClose"
  | "onAction"
>;

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-session-menu": HTMLAttributes<SessionMenuElement> & {
        [Key in keyof SessionMenuProperties as `prop:${Key}`]: SessionMenuProperties[Key];
      };
    }
  }
}

type SessionsPageMenuAction = Exclude<SessionMenuAction, { kind: "snooze" | "wake" }>;

export type SessionsPageMenuProps = {
  context: ApplicationContext;
  row: GatewaySessionRow;
  menu: { key: string; sessionId?: string; x: number; y: number };
  trigger: HTMLElement | null;
  disabled: boolean;
  groups: string[];
  work: SessionMenuWork | null;
  onClose: () => void;
  onAction: (action: SessionsPageMenuAction) => void;
};

export function SessionManagementMenu(props: SessionsPageMenuProps) {
  const state = createMemo(() => {
    const context = props.context;
    const row = props.row;
    const gateway = context.gateway.snapshot;
    const mainKey = resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: gateway.hello,
    });
    const cloudWorkerStopAction = resolveCloudWorkerStopAction(row.placement);
    const pinnable = isPinnableUiSessionRow(row);
    return {
      session: {
        label: normalizeOptionalString(row.label) ?? row.key,
        target: { key: row.key, agentId: row.agentId },
        sessionId: normalizeOptionalString(row.sessionId) ?? null,
        isChild:
          !isSubagentSessionKey(row.key) &&
          Boolean(
            resolveSidebarSessionParentKey(
              row,
              new Set([buildAgentMainSessionKey({ agentId: row.agentId ?? "main", mainKey })]),
            ),
          ),
        hasChildren: hasSessionArchiveDescendants(
          row,
          context.sessions.state.result?.sessions ?? [],
        ),
        pinned: context.navigation.snapshot.sidebarEntries.includes(
          serializeSidebarEntry({ type: "session", key: row.key }),
        ),
        pinnable,
        snoozedUntil: row.snoozedUntil ?? null,
        unread: row.unread === true,
        hiddenFromInvolvingMe: row.hiddenFromInvolvingMe,
        communication: row.communication,
        effectiveCommunication: row.effectiveCommunication,
        archived: row.archived === true,
        archiving: context.sessions.archiveVisibility(row.key) === "pending",
        category: normalizeOptionalString(row.category) ?? null,
        icon: normalizeOptionalString(row.icon) ?? null,
        color: normalizeOptionalString(row.color) ?? null,
        categoryClearReturnsToGroups: false,
      },
      compact: isMobileNavLayout(),
      copyMarkdownAllowed: canCopySessionMarkdown(gateway),
      actionDisabledReasons: sessionMenuReasons({
        snapshot: gateway,
        session: { ...row, pinnable },
        cloudWorkerStopAction,
      }),
      archiveAllowed: canArchiveSessionRow(row, mainKey),
      deleteAllowed: canDeleteSessionRows([row], mainKey),
      cloudWorkerStopAllowed: Boolean(
        cloudWorkerStopAction &&
        (!cloudWorkerStopAction.blocksActiveRun || row.hasActiveRun !== true) &&
        isGatewayMethodAdvertised(gateway, cloudWorkerStopAction.method) === true,
      ),
      pluginActions: pluginSessionMenuActions(context.plugins, row),
    };
  });
  return (
    <openclaw-session-menu
      prop:session={state().session}
      prop:compact={state().compact}
      prop:anchor={props.menu}
      prop:trigger={props.trigger}
      prop:disabled={props.disabled}
      prop:navigationAllowed={true}
      prop:copyMarkdownAllowed={state().copyMarkdownAllowed}
      prop:splitAllowed={false}
      prop:actionDisabledReasons={state().actionDisabledReasons}
      prop:forkDisabled={props.row.modelSelectionLocked === true}
      prop:forkFromLastCompleted={props.row.hasActiveRun === true}
      prop:archiveAllowed={state().archiveAllowed}
      prop:deleteAllowed={state().deleteAllowed}
      prop:cloudWorkerStopAllowed={state().cloudWorkerStopAllowed}
      prop:groups={props.groups}
      prop:currentOwner={props.row.owner?.actor ?? null}
      prop:work={props.work}
      prop:pluginActions={state().pluginActions}
      prop:onClose={() => props.onClose()}
      prop:onAction={(action: SessionMenuAction) => {
        // Snooze controls belong to the sidebar; the page retains its existing action contract.
        if (action.kind !== "snooze" && action.kind !== "wake") {
          props.onAction(action);
        }
      }}
    />
  );
}

/** Consume navigation here; the caller owns the remaining management actions. */
export function handleSessionManagementNavigationAction(
  action: SessionsPageMenuAction,
  params: { context: ApplicationContext; row: GatewaySessionRow; isCurrent: () => boolean },
) {
  const { context, row, isCurrent } = params;
  switch (action.kind) {
    case "open-pr":
      openExternalUrlSafe(action.url);
      return undefined;
    case "open-in":
      openEditor(action.editor, action.path);
      return undefined;
    case "copy-session-id":
    case "copy-session-link":
    case "copy-session-preview-link":
    case "copy-markdown":
    case "open-new-tab":
    case "open-new-window":
    case "split-right":
    case "split-below":
      void runSessionNavigationAction(action.kind, {
        context,
        session: row,
        agentId: row.agentId,
        isCurrent,
      });
      return undefined;
    default:
      return action;
  }
}
