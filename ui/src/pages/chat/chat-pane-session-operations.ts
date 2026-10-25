import type { GatewaySessionRow } from "../../api/types.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "../../components/app-sidebar-session-types.ts";
import {
  createHeaderSessionActionHost,
  createHeaderSessionActionRows,
  headerSessionMetadataPatch,
  renameSession as renameHeaderSession,
} from "./chat-pane-session-metadata-patch.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";

type HeaderSessionOperation = Exclude<
  HeaderMenuAction,
  {
    kind:
      | "move-session"
      | "stop-cloud-worker"
      | "open-in"
      | "copy-session-id"
      | "copy-session-link"
      | "copy-session-preview-link"
      | "copy-markdown"
      | "open-new-tab"
      | "open-new-window"
      | "split-right"
      | "split-below"
      | "continue-in-terminal"
      | "toggle-pin"
      | "new-group"
      | "plugin";
  }
>;

export async function runHeaderSessionOperation(
  action: HeaderSessionOperation,
  row: GatewaySessionRow,
  scope: SidebarSessionMutationScope,
  callbacks: {
    isCurrent(scope: SidebarSessionMutationScope): boolean;
    publishError(error: unknown): void;
    selectSession(key: string): void;
    label(row: GatewaySessionRow): string;
    rows(): readonly GatewaySessionRow[];
    state(): ChatPageHost | undefined;
    draftSignal: AbortSignal;
    beginRename(state: ChatPageHost): {
      scope: SidebarSessionMutationScope;
      isCurrent(): boolean;
      publishError(error: unknown): void;
    } | null;
  },
): Promise<SidebarSessionMutationResult | void> {
  if (!callbacks.isCurrent(scope)) {
    return;
  }
  const { session, resolveCurrentSession } = createHeaderSessionActionRows(scope, row, callbacks);
  const {
    archiveSessionWithUndo,
    assignSessionCategory,
    assignSessionOwner,
    deleteSession,
    forkSession,
    patchSession,
    promoteSession,
    renameSession,
    setSessionInvolvement,
    snoozeSessionWithUndo,
  } = await import("../../components/session-organizer-operations.runtime.ts");
  if (!callbacks.isCurrent(scope)) {
    return;
  }
  const host = createHeaderSessionActionHost(scope, callbacks);
  const draftSignal = callbacks.draftSignal;
  const assignCategory = (category: string | null) =>
    assignSessionCategory(host, session, category, scope, {
      resolveSession: resolveCurrentSession,
    });
  switch (action.kind) {
    case "rename": {
      const state = callbacks.state();
      if (!state) {
        return;
      }
      return await renameHeaderSession({ renameSession }, host, row, scope, {
        state,
        signal: draftSignal,
        begin: () => callbacks.beginRename(state),
      });
    }
    case "toggle-involving-me":
      await setSessionInvolvement(host, session, !row.hiddenFromInvolvingMe, scope);
      break;
    case "toggle-unread":
    case "set-icon":
    case "set-color":
    case "set-communication":
    case "reset-appearance": {
      const currentSession = resolveCurrentSession(true);
      if (currentSession) {
        const patch = headerSessionMetadataPatch(action, currentSession);
        await patchSession(host, currentSession, patch, scope, {
          sessionScope: action.kind === "toggle-unread",
        });
      }
      break;
    }
    case "assign-owner":
      await assignSessionOwner(host, session, action.owner, scope);
      break;
    case "fork":
      await forkSession(host, session, scope);
      break;
    case "move-to-top-level":
      await promoteSession(host, session, scope);
      break;
    case "move-to-group":
      return await assignCategory(action.category);
    case "snooze":
      await snoozeSessionWithUndo(host, session, action, scope);
      break;
    case "wake":
      await patchSession(host, session, { snoozedUntil: null }, scope, {
        sessionScope: true,
      });
      break;
    case "toggle-archived":
      if (session.archived) {
        await patchSession(host, session, { archived: false }, scope, {
          sessionScope: true,
        });
      } else {
        await archiveSessionWithUndo(host, session, scope);
      }
      break;
    case "delete":
      await deleteSession(host, session, scope);
      break;
    default:
      action satisfies never;
  }
}
