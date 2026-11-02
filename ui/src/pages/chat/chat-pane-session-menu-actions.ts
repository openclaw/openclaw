import type {
  SessionsFilesRevealResult,
  WorktreesBranchesResult,
  WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import type {
  SidebarSessionMutationScope,
  SidebarSessionMutationResult,
} from "../../components/app-sidebar-session-types.ts";
import { showInputDialog } from "../../components/input-dialog.tsx";
import { isCloudWorkerPlacementState } from "../../components/session-row-badge-presentation.ts";
import { t } from "../../i18n/index.ts";
import { requestCheckoutSnapshot } from "../../lib/checkout-snapshot.ts";
import { openEditor } from "../../lib/editor-links.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  isPinnableUiSessionRow,
  isNativeCatalogAdoptionSessionKey,
} from "../../lib/sessions/session-key.ts";
import { runSessionNavigationAction } from "../../lib/sessions/session-menu-navigation.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import type {
  ChatHeaderSessionActionSource,
  ChatHeaderWorkspaceDataOwner,
  HeaderMenuAction,
  HeaderSessionOperation,
} from "./chat-pane-session-menu-contract.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";

export async function openHeaderSessionGroup(
  owner: Pick<ReturnType<ChatHeaderSessionActionSource["readOwner"]>, "context" | "state">,
  moveToGroup: (name: string) => Promise<SidebarSessionMutationResult | void>,
  signal: AbortSignal,
): Promise<void> {
  const gateway = owner.context.gateway;
  await showInputDialog({
    signal,
    gateway,
    title: t("sessionsView.newGroupTitle"),
    label: t("sessionsView.newGroupPrompt"),
    submitLabel: t("sessionsView.newGroupCreate"),
    requireValue: true,
    submit: async (name) => {
      const result = await moveToGroup(name);
      return result === "completed"
        ? null
        : result === "stale"
          ? t("sessionsView.newGroupStale")
          : (owner.state?.chatError ?? t("sessionsView.newGroupFailed"));
    },
  });
}

export async function revealHeaderWorkspace(
  owner: Pick<
    ReturnType<ChatHeaderSessionActionSource["readOwner"]>,
    "context" | "ownsHeaderOutcome" | "publishHeaderError"
  >,
  row: GatewaySessionRow,
  outcomeOwner: string,
): Promise<void> {
  const client = owner.context.gateway.snapshot.client;
  if (!client || !owner.ownsHeaderOutcome(outcomeOwner)) {
    return;
  }
  const agentId = parseAgentSessionKey(row.key)?.agentId;
  const result = await client.request<SessionsFilesRevealResult>("sessions.files.reveal", {
    key: row.key,
    ...(agentId ? { agentId } : {}),
  });
  if (!result.ok) {
    owner.publishHeaderError(result.error ?? "Failed to reveal session workspace.", outcomeOwner);
  }
}

export async function loadHeaderWorkspaceData(
  owner: ChatHeaderWorkspaceDataOwner,
  row: GatewaySessionRow,
  agentWorkspace: string | undefined,
  workspaceGit: boolean,
  outcomeOwner: string,
): Promise<void> {
  const client = owner.context.gateway.snapshot.client;
  if (!client || !owner.ownsHeaderOutcome(outcomeOwner)) {
    return;
  }
  const header = owner.headerPresentation;
  const loads: Promise<void>[] = [];
  // Same precedence as resolveChatPaneWorkspace/loadSessionFileRoot.
  const immediateRoot =
    row.deviceFolder?.path ||
    (row.execNode ? row.execCwd?.trim() : undefined) ||
    row.spawnedWorkspaceDir?.trim() ||
    row.spawnedCwd?.trim() ||
    null;
  const worktreeId = row.worktree?.id;
  if (worktreeId && !immediateRoot) {
    const entry = header.worktreePaths.get(worktreeId) ?? {};
    header.worktreePaths.set(worktreeId, entry);
    if (entry.path === undefined && !entry.loading) {
      entry.loading = true;
      loads.push(
        client
          .request<WorktreesListResult>("worktrees.list", {})
          .then((result) => {
            entry.path =
              result.worktrees.find(
                (candidate) => candidate.id === worktreeId && candidate.removedAt === undefined,
              )?.path ?? null;
          })
          .catch(() => {
            entry.path = undefined;
          })
          .finally(() => {
            entry.loading = false;
            if (header.worktreePaths.get(worktreeId) === entry) {
              header.worktreePaths = new Map(header.worktreePaths);
            }
          }),
      );
    }
  }
  const agentRoot = !row.worktree ? agentWorkspace?.trim() : undefined;
  const knownRoot =
    immediateRoot ||
    (worktreeId ? header.worktreePaths.get(worktreeId)?.path : undefined) ||
    agentRoot;
  const remote = Boolean(row.execNode) || isCloudWorkerPlacementState(row.placement?.state);
  // workspaceGit describes the agent workspace only; a session-specific
  // root (spawned dir) may be a Git checkout regardless.
  const rootMayHaveBranch = knownRoot === agentRoot ? workspaceGit : Boolean(knownRoot);
  // HEAD can move mid-session, so refetch on every open while keeping the
  // last-known branch visible during the refresh to avoid menu flicker.
  if (
    !row.worktree &&
    !remote &&
    knownRoot &&
    rootMayHaveBranch &&
    hasOperatorWriteAccess(owner.context.gateway.snapshot.hello?.auth ?? null)
  ) {
    const entry = header.branches.get(knownRoot) ?? {};
    header.branches.set(knownRoot, entry);
    if (!entry.loading) {
      entry.loading = true;
      loads.push(
        (async () => {
          try {
            const result = await requestCheckoutSnapshot<WorktreesBranchesResult>(
              owner.context.gateway,
              "worktrees.branches",
              { repoRoot: knownRoot },
            );
            if (owner.ownsHeaderOutcome(outcomeOwner)) {
              entry.value = result.headBranch ?? null;
            }
          } catch {
            entry.value = null;
          } finally {
            entry.loading = false;
            if (header.branches.get(knownRoot) === entry) {
              header.branches = new Map(header.branches);
            }
          }
        })(),
      );
    }
  }
  await Promise.all(loads);
}

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
