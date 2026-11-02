import type { GatewaySessionRow } from "../../api/types.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import type {
  SidebarSessionMutationScope,
  SidebarSessionMutationResult,
} from "../../components/app-sidebar-session-types.ts";
import { t } from "../../i18n/index.ts";
import { openEditor } from "../../lib/editor-links.ts";
import {
  areUiSessionKeysEquivalent,
  isPinnableUiSessionRow,
  isNativeCatalogAdoptionSessionKey,
} from "../../lib/sessions/session-key.ts";
import { runSessionNavigationAction } from "../../lib/sessions/session-menu-navigation.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import type {
  ChatHeaderSessionActionSource,
  HeaderMenuAction,
  HeaderSessionOperation,
} from "./chat-pane-session-menu-contract.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";

/** Loaded by the menu before its actions exist; gesture-bound work stays synchronous. */
export async function runChatHeaderSessionAction(
  owner: ReturnType<ChatHeaderSessionActionSource["readOwner"]>,
  action: HeaderMenuAction,
  row: GatewaySessionRow,
): Promise<SidebarSessionMutationResult | void> {
  if (action.kind === "delete" && isNativeCatalogAdoptionSessionKey(row.key)) {
    return;
  }
  if (action.kind === "move-session" || action.kind === "stop-cloud-worker") {
    return owner.changeHeaderPlacement(row, action.kind === "move-session" ? "move" : "reclaim");
  }
  if (action.kind === "toggle-archived" && !row.archived && !owner.canArchiveHeaderSession(row)) {
    return;
  }
  if (action.kind === "open-in") {
    openEditor(action.editor, action.path);
    return;
  }
  if (action.kind === "rename" && !owner.mergedChrome) {
    return owner.beginHeaderRename(row);
  }
  if (
    action.kind === "copy-session-id" ||
    action.kind === "copy-session-link" ||
    action.kind === "copy-session-preview-link" ||
    action.kind === "copy-markdown" ||
    action.kind === "open-new-tab" ||
    action.kind === "open-new-window" ||
    action.kind === "split-right" ||
    action.kind === "split-below"
  ) {
    const ownerKey = owner.headerOutcomeOwner;
    await runSessionNavigationAction(action.kind, {
      context: owner.context,
      session: row,
      agentId: owner.state ? resolveChatAgentId(owner.state) : row.agentId,
      sourceSessionKey: row.key,
      isCurrent: () => owner.ownsHeaderOutcome(ownerKey),
    });
    return;
  }
  if (action.kind === "continue-in-terminal") {
    owner.openContinueInTerminalDialog(row);
    return;
  }
  if (action.kind === "toggle-pin") {
    const current = owner.state ? selectedChatSessionRow(owner.state) : undefined;
    if (
      !current ||
      !areUiSessionKeysEquivalent(current.key, row.key) ||
      (row.sessionId && current.sessionId !== row.sessionId) ||
      !isPinnableUiSessionRow(current)
    ) {
      return;
    }
    togglePinnedSession(owner.context.navigation, current.key);
    return;
  }
  if (action.kind === "new-group") {
    return owner.openHeaderSessionGroup((name) =>
      runHeaderSessionMutation(owner, { kind: "move-to-group", category: name }, row),
    );
  }
  if (action.kind === "plugin") {
    const scope = owner.captureHeaderSessionActionScope();
    if (!scope) {
      owner.publishHeaderError(t("sessionsView.actionRequiresConnection"));
      return;
    }
    const ownerKey = owner.headerOutcomeOwner;
    const current = owner.state ? selectedChatSessionRow(owner.state) : undefined;
    try {
      await runControlUiPluginAction({
        runtime: owner.context.plugins,
        id: action.id,
        placement: "session",
        sessionKey: row.key,
        agentId: row.agentId,
        session:
          current?.key === row.key && current.sessionId === row.sessionId ? current : undefined,
        signal: scope.signal,
      });
    } catch (error) {
      owner.publishHeaderError(error, ownerKey);
    }
    return;
  }
  return runHeaderSessionMutation(owner, action, row);
}

type HeaderSessionMutationAdmission = {
  scope: SidebarSessionMutationScope & { signal: AbortSignal };
  owner: string;
  draftSignal: AbortSignal;
};
export async function runHeaderSessionMutation(
  owner: ReturnType<ChatHeaderSessionActionSource["readOwner"]>,
  action: HeaderSessionOperation,
  row: GatewaySessionRow,
  admission?: HeaderSessionMutationAdmission,
): Promise<SidebarSessionMutationResult | void> {
  const scope =
    admission?.scope ??
    owner.captureHeaderSessionActionScope(
      action.kind === "rename" ||
        action.kind === "set-icon" ||
        action.kind === "set-color" ||
        action.kind === "reset-appearance" ||
        action.kind === "toggle-archived" ||
        action.kind === "delete" ||
        action.kind === "move-to-group",
    );
  if (!scope) {
    owner.publishHeaderError(t("sessionsView.actionRequiresConnection"));
    return;
  }
  const outcomeOwner = admission?.owner ?? owner.headerOutcomeOwner;
  const draftSignal = admission?.draftSignal ?? owner.headerSessionDraftAbortController.signal;
  const capturedRow = admission ? row : { ...row };
  try {
    const { runHeaderSessionOperation } = await import("./chat-pane-session-operations.ts");
    return await runHeaderSessionOperation(action, capturedRow, scope, {
      isCurrent: (candidate) => owner.isHeaderSessionActionCurrent(candidate, outcomeOwner),
      publishError: (error) => owner.publishHeaderError(error, outcomeOwner),
      selectSession: (key) => owner.onPaneSessionChange?.(owner.paneId, key),
      label: (candidate) => owner.resolveHeaderSessionTitle(candidate),
      rows: () => owner.state?.sessionsResult?.sessions ?? [],
      state: () => owner.state,
      draftSignal,
      beginRename: (state) => {
        if (owner.state !== state || !owner.presented) {
          return null;
        }
        const currentScope = owner.captureHeaderSessionActionScope(true);
        if (!currentScope) {
          return null;
        }
        const currentOwner = owner.headerOutcomeOwner;
        return {
          scope: currentScope,
          isCurrent: () =>
            owner.state === state && owner.isHeaderSessionActionCurrent(currentScope, currentOwner),
          publishError: (error) => owner.publishHeaderError(error, currentOwner),
        };
      },
    });
  } catch (error) {
    if (owner.isHeaderSessionActionCurrent(scope, outcomeOwner)) {
      owner.publishHeaderError(error, outcomeOwner);
    }
  }
}
