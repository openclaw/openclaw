import type {
  SessionsFilesRevealResult,
  WorktreesBranchesResult,
  WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import { resolveSidebarSessionParentKey } from "../../components/app-sidebar-session-parent.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "../../components/app-sidebar-session-types.ts";
import { hasModalSurface } from "../../components/overlay-registry.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import type { SessionMenuData } from "../../components/session-menu-actions.ts";
import { sessionMenuDataFromRow } from "../../components/session-menu-data.ts";
import {
  captureSessionMutationScope,
  isSessionMutationScopeCurrent,
} from "../../components/session-mutation-scope.ts";
import type * as SessionOperations from "../../components/session-organizer-operations.runtime.ts";
import { sessionPlacementAction } from "../../components/session-placement-action.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { openEditor } from "../../lib/editor-links.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../lib/keyboard-shortcut-contract.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionRenamePatch, resolveSessionRenameValue } from "../../lib/session-rename.ts";
import {
  areUiSessionKeysEquivalent,
  canArchiveSessionRow,
  isPinnableUiSessionRow,
  isNativeCatalogAdoptionSessionKey,
  parseAgentSessionKey,
  isSubagentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { runSessionNavigationAction } from "../../lib/sessions/session-menu-navigation.ts";
import { readSystemInfo } from "../../lib/system-info.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { ChatPaneContext } from "./chat-pane-context.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import {
  createHeaderSessionActionHost,
  createHeaderSessionActionRows,
  headerSessionMetadataPatch,
  renameSession,
} from "./chat-pane-session-metadata-patch.ts";
import { chatSessionPresentationTitle } from "./chat-pane-session-presentation.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";
import type { ChatPaneHeaderAction } from "./components/chat-pane-header.types.ts";
import { buildContinueInTerminalCommand } from "./continue-in-terminal-command.ts";

export abstract class ChatPaneSessionMenu extends ChatPaneContext {
  private readonly headerSessionDataMemo = new ChatPaneHeaderMemo<SessionMenuData>();
  protected resolveHeaderSessionTitle(row: GatewaySessionRow | undefined): string {
    const state = this.state;
    const hydration = state && chatHistoryRequests(state).initialSnapshotHydration;
    const session = row ?? this.resourceSessionObservation()?.row ?? undefined;
    return chatSessionPresentationTitle(
      state,
      session ?? this.transcriptSessionProps(session).transcriptMetadata,
      this.sessionKey,
      Boolean(
        hydration?.titlePending &&
        areUiSessionKeysEquivalent(hydration.sessionKey, this.sessionKey),
      ),
    );
  }

  protected canArchiveHeaderSession(row: GatewaySessionRow): boolean {
    return (
      !row.archived &&
      !this.context.sessions.archiveVisibility(row.key) &&
      canArchiveSessionRow(
        row,
        resolveUiConfiguredMainKey({
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
        }),
      ) &&
      !sessionMenuReasons({ snapshot: this.context.gateway.snapshot, session: row })[
        "toggle-archived"
      ]
    );
  }

  protected readonly handleArchiveSessionShortcut = (event: KeyboardEvent): boolean => {
    if (!matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.archiveSession, event)) {
      return false;
    }
    const state = this.state;
    if (
      event.repeat ||
      event.defaultPrevented ||
      !state?.connected ||
      !this.active ||
      !this.presented ||
      this.onboarding ||
      hasModalSurface(this.element.ownerDocument)
    ) {
      return true;
    }
    // The pane's current conversation is authoritative, never sidebar selection.
    const row = selectedChatSessionRow(state);
    if (!row || !this.canArchiveHeaderSession(row)) {
      return true;
    }
    event.preventDefault();
    void this.handleHeaderSessionAction({ kind: "toggle-archived" }, row);
    return true;
  };

  protected headerSessionMenuData(row: GatewaySessionRow, pinnable: boolean): SessionMenuData {
    const mainSessionKey = resolveUiConversationIdentity(
      {
        agentsList: this.context.agents.state.agentsList,
        hello: this.context.gateway.snapshot.hello,
      },
      "main",
      parseAgentSessionKey(row.key)?.agentId ?? row.agentId,
    ).sessionKey;
    const label = this.resolveHeaderSessionTitle(row);
    const isChild =
      !isSubagentSessionKey(row.key) &&
      Boolean(resolveSidebarSessionParentKey(row, new Set([mainSessionKey])));
    const archiving = this.context.sessions.archiveVisibility(row.key) === "pending";
    const pinned = this.context.navigation.snapshot.sidebarEntries.includes(
      serializeSidebarEntry({ type: "session", key: row.key }),
    );
    return this.headerSessionDataMemo.read(
      [
        label,
        sessionPlacementAction(row),
        row.key,
        row.agentId,
        row.sessionId,
        isChild,
        pinned,
        pinnable,
        row.snoozedUntil,
        row.unread,
        row.hiddenFromInvolvingMe,
        row.communication,
        row.effectiveCommunication,
        row.archived,
        archiving,
        row.category,
        row.icon,
        row.color,
      ],
      () => sessionMenuDataFromRow(row, { label, isChild, pinned, pinnable, archiving }),
    );
  }

  private headerSessionOperationsLoad: Promise<typeof SessionOperations> | null = null;
  protected async loadHeaderPlatform(
    client: GatewayBrowserClient,
    generation: number,
  ): Promise<void> {
    const gateway = this.context.gateway;
    const platform = await readSystemInfo(gateway)
      .then((sample) => sample.value.platform)
      .catch(() => null);
    if (
      this.context.gateway === gateway &&
      this.connectedClient === client &&
      this.connectionGeneration === generation
    ) {
      this.headerPresentation.platform = platform;
    }
  }

  protected async handleHeaderSessionAction(
    action: HeaderMenuAction,
    row: GatewaySessionRow,
  ): Promise<SidebarSessionMutationResult | void> {
    if (action.kind === "delete" && isNativeCatalogAdoptionSessionKey(row.key)) {
      return;
    }
    if (action.kind === "move-session" || action.kind === "stop-cloud-worker") {
      return this.changeHeaderPlacement(row, action.kind === "move-session" ? "move" : "reclaim");
    }
    if (action.kind === "toggle-archived" && !row.archived && !this.canArchiveHeaderSession(row)) {
      return;
    }
    if (action.kind === "open-in") {
      openEditor(action.editor, action.path);
      return;
    }
    if (action.kind === "rename" && !this.mergedChrome) {
      return this.beginHeaderRename(row);
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
      const owner = this.headerOutcomeOwner;
      await runSessionNavigationAction(action.kind, {
        context: this.context,
        session: row,
        agentId: this.state ? resolveChatAgentId(this.state) : row.agentId,
        sourceSessionKey: row.key,
        isCurrent: () => this.ownsHeaderOutcome(owner),
      });
      return;
    }
    if (action.kind === "continue-in-terminal") {
      this.openContinueInTerminalDialog(row);
      return;
    }
    if (action.kind === "toggle-pin") {
      const current = this.state ? selectedChatSessionRow(this.state) : undefined;
      if (
        !current ||
        !areUiSessionKeysEquivalent(current.key, row.key) ||
        (row.sessionId && current.sessionId !== row.sessionId) ||
        !isPinnableUiSessionRow(current)
      ) {
        return;
      }
      togglePinnedSession(this.context.navigation, current.key);
      return;
    }
    if (action.kind === "new-group") {
      const signal = this.headerSessionDraftAbortController.signal;
      const gateway = this.context.gateway;
      const { showInputDialog } = await import("../../components/input-dialog.ts");
      await showInputDialog({
        signal,
        gateway,
        title: t("sessionsView.newGroupTitle"),
        label: t("sessionsView.newGroupPrompt"),
        submitLabel: t("sessionsView.newGroupCreate"),
        requireValue: true,
        submit: async (name) => {
          const result = await this.handleHeaderSessionAction(
            { kind: "move-to-group", category: name },
            row,
          );
          return result === "completed"
            ? null
            : result === "stale"
              ? t("sessionsView.newGroupStale")
              : (this.state?.chatError ?? t("sessionsView.newGroupFailed"));
        },
      });
      return;
    }
    const scope = this.captureHeaderSessionActionScope(
      action.kind === "rename" ||
        action.kind === "set-icon" ||
        action.kind === "set-color" ||
        action.kind === "reset-appearance" ||
        action.kind === "move-to-group",
    );
    if (!scope) {
      this.publishHeaderError(t("sessionsView.actionRequiresConnection"));
      return;
    }
    const owner = this.headerOutcomeOwner;
    const draftSignal = this.headerSessionDraftAbortController.signal;
    if (action.kind === "plugin") {
      const current = this.state ? selectedChatSessionRow(this.state) : undefined;
      try {
        await runControlUiPluginAction({
          runtime: this.context.plugins,
          id: action.id,
          placement: "session",
          sessionKey: row.key,
          agentId: row.agentId,
          session:
            current?.key === row.key && current.sessionId === row.sessionId ? current : undefined,
          signal: scope.signal,
        });
      } catch (error) {
        this.publishHeaderError(error, owner);
      }
      return;
    }
    const { session, resolveCurrentSession } = createHeaderSessionActionRows(scope, row, {
      label: (candidate) => this.resolveHeaderSessionTitle(candidate),
      rows: () => this.state?.sessionsResult?.sessions ?? [],
    });
    try {
      const operations = await (this.headerSessionOperationsLoad ??=
        import("../../components/session-organizer-operations.runtime.ts"));
      const host = createHeaderSessionActionHost(scope, {
        isCurrent: (candidate) => this.isHeaderSessionActionCurrent(candidate, owner),
        publishError: (error) => this.publishHeaderError(error, owner),
        selectSession: (key) => this.onPaneSessionChange?.(this.paneId, key),
      });
      const assignCategory = (category: string | null) =>
        operations.assignSessionCategory(
          host,
          session,
          category,
          scope,
          {},
          { resolveSession: resolveCurrentSession },
        );
      switch (action.kind) {
        case "rename": {
          const state = this.state;
          if (!state) {
            return;
          }
          return await renameSession(operations, host, row, scope, {
            state,
            signal: draftSignal,
            begin: () => {
              if (this.state !== state || !this.presented) {
                return null;
              }
              const currentScope = this.captureHeaderSessionActionScope(true);
              if (!currentScope) {
                return null;
              }
              const currentOwner = this.headerOutcomeOwner;
              return {
                scope: currentScope,
                isCurrent: () =>
                  this.state === state &&
                  this.isHeaderSessionActionCurrent(currentScope, currentOwner),
                publishError: (error) => this.publishHeaderError(error, currentOwner),
              };
            },
          });
        }
        case "toggle-involving-me":
          await operations.setSessionInvolvement(host, session, !row.hiddenFromInvolvingMe, scope);
          break;
        case "toggle-unread":
        case "set-icon":
        case "set-color":
        case "set-communication":
        case "reset-appearance": {
          const currentSession = resolveCurrentSession(true);
          if (currentSession) {
            const patch = headerSessionMetadataPatch(action, currentSession);
            await operations.patchSession(host, currentSession, patch, scope, {
              sessionScope: action.kind === "toggle-unread",
            });
          }
          break;
        }
        case "assign-owner":
          await operations.assignSessionOwner(host, session, action.owner, scope);
          break;
        case "fork":
          await operations.forkSession(host, session, scope);
          break;
        case "move-to-top-level":
          await operations.promoteSession(host, session, scope);
          break;
        case "move-to-group":
          return await assignCategory(action.category);
        case "snooze":
          await operations.snoozeSessionWithUndo(host, session, action, scope);
          break;
        case "wake":
          await operations.patchSession(host, session, { snoozedUntil: null }, scope, {
            sessionScope: true,
          });
          break;
        case "toggle-archived":
          if (session.archived) {
            await operations.patchSession(host, session, { archived: false }, scope, {
              sessionScope: true,
            });
          } else {
            await operations.archiveSessionWithUndo(host, session, scope);
          }
          break;
        case "delete":
          await operations.deleteSession(host, session, scope);
          break;
        default:
          action satisfies never;
      }
    } catch (error) {
      if (this.isHeaderSessionActionCurrent(scope, owner)) {
        this.publishHeaderError(error, owner);
      }
    }
  }

  private resolveContinueInTerminalCommand(row: GatewaySessionRow, client: GatewayBrowserClient) {
    return buildContinueInTerminalCommand({
      gatewayUrl: client.gatewayUrl,
      sessionKey: row.key,
      rowAgentId: row.agentId,
      selectedAgentId: this.context.agentSelection.state.selectedId ?? undefined,
    });
  }

  protected continueInTerminalDisabledReason(row: GatewaySessionRow): string | undefined {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return t("chat.sessionHeader.continueInTerminal.disconnected");
    }
    const result = this.resolveContinueInTerminalCommand(row, client);
    if (result.ok) {
      return undefined;
    }
    return t(
      result.reason === "query-routed"
        ? "chat.sessionHeader.continueInTerminal.queryRouted"
        : "chat.sessionHeader.continueInTerminal.unavailable",
    );
  }

  private openContinueInTerminalDialog(row: GatewaySessionRow): void {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const result = this.resolveContinueInTerminalCommand(row, scope.client);
    if (!result.ok) {
      return;
    }
    this.headerPresentation.continueInTerminalDialog = {
      qualifiedSessionKey: result.qualifiedSessionKey,
      selectedGatewayUrl: this.context.gateway.connection.gatewayUrl,
      clientGatewayUrl: scope.client.gatewayUrl,
      scope,
    };
  }

  protected closeContinueInTerminalDialog(): void {
    this.headerPresentation.continueInTerminalDialog = null;
  }

  protected currentContinueInTerminalCommand(row: GatewaySessionRow | undefined): string | null {
    const dialog = this.headerPresentation.continueInTerminalDialog;
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (!dialog) {
      return null;
    }
    const result = row && client ? this.resolveContinueInTerminalCommand(row, client) : null;
    if (
      !this.isConnectionScopeCurrent(dialog.scope) ||
      !result?.ok ||
      result.qualifiedSessionKey !== dialog.qualifiedSessionKey ||
      gateway.connection.gatewayUrl !== dialog.selectedGatewayUrl ||
      client?.gatewayUrl !== dialog.clientGatewayUrl
    ) {
      this.headerPresentation.continueInTerminalDialog = null;
      return null;
    }
    return result.command;
  }

  private captureHeaderSessionActionScope(
    allowDeferred = false,
  ): (SidebarSessionMutationScope & { signal: AbortSignal }) | null {
    return captureSessionMutationScope(this.context, {
      epoch: this.connectionGeneration,
      allowDeferred,
      selectedAgentId: this.context.agentSelection.state.selectedId ?? "main",
      signal: this.headerSessionMutationAbortController.signal,
    });
  }

  private isHeaderSessionActionCurrent(scope: SidebarSessionMutationScope, owner: string): boolean {
    return this.ownsHeaderOutcome(owner) && isSessionMutationScopeCurrent(this.context, scope);
  }

  protected beginHeaderRename(row: GatewaySessionRow): void {
    const header = this.headerPresentation;
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: row.key, label: null },
      sessionScope: true,
      session: row,
      allowDeferred: true,
    });
    if (!access.allowed) {
      this.publishHeaderError(access.reason);
      return;
    }
    // The edit belongs to this instance, even if a replacement reuses its key.
    const { key, sessionId, label } = row;
    header.renameSession = { key, sessionId, label };
    this.headerRenameInitialValue = resolveSessionRenameValue(row);
    header.renameValue = this.headerRenameInitialValue;
  }

  protected cancelHeaderRename(): void {
    this.headerPresentation.renameSession = null;
  }

  protected commitHeaderRename(): void {
    const session = this.headerPresentation.renameSession;
    if (!session) {
      return;
    }
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.phase !== "connected" && !snapshot.hello) {
      return;
    }
    const patch = resolveSessionRenamePatch(
      this.headerPresentation.renameValue,
      this.headerRenameInitialValue,
      session.label,
    );
    this.headerPresentation.renameSession = null;
    const state = this.state;
    if (!state || !patch) {
      return;
    }
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: session.key, ...patch },
      sessionScope: true,
      allowDeferred: true,
      session: state.sessionsResult?.sessions.find(
        (row) =>
          areUiSessionKeysEquivalent(row.key, session.key) && row.sessionId === session.sessionId,
      ),
    });
    if (!access.allowed) {
      this.publishHeaderError(access.reason);
      return;
    }
    const owner = this.headerOutcomeOwner;
    void this.context.sessions
      .patch(session.key, patch, {
        agentId: resolveChatAgentId(state),
        expectedSessionId: session.sessionId,
      })
      .catch((error: unknown) => this.publishHeaderError(error, owner));
  }

  protected async loadHeaderMenuData(
    row: GatewaySessionRow,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
  ): Promise<void> {
    const header = this.headerPresentation;
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    const loads = [this.loadHeaderPlatform(client, this.connectionGeneration)];
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
    if (!row.worktree && !remote && knownRoot && rootMayHaveBranch) {
      const entry = header.branches.get(knownRoot) ?? {};
      header.branches.set(knownRoot, entry);
      if (!entry.loading) {
        entry.loading = true;
        loads.push(
          client
            .request<WorktreesBranchesResult>("worktrees.branches", { repoRoot: knownRoot })
            .then((result) => {
              entry.value = result.headBranch ?? null;
            })
            .catch(() => {
              entry.value = null;
            })
            .finally(() => {
              entry.loading = false;
              if (header.branches.get(knownRoot) === entry) {
                header.branches = new Map(header.branches);
              }
            }),
        );
      }
    }
    await Promise.all(loads);
  }

  protected handleHeaderMenuAction(
    action: ChatPaneHeaderAction,
    row: GatewaySessionRow,
    workspaceRoot: string | null,
    branch: string | null,
  ): void {
    const copiedValue =
      action === "copy-path" ? workspaceRoot : action === "copy-branch" ? branch : null;
    if (copiedValue) {
      const owner = this.headerOutcomeOwner;
      void copyToClipboard(copiedValue).then((copied) => {
        if (!this.ownsHeaderOutcome(owner)) {
          return;
        }
        if (copied) {
          this.headerPresentation.copiedAction = action;
          if (this.headerCopiedTimer !== null) {
            window.clearTimeout(this.headerCopiedTimer);
          }
          this.headerCopiedTimer = window.setTimeout(() => {
            this.headerPresentation.copiedAction = null;
            this.headerCopiedTimer = null;
          }, 1_500);
        } else {
          this.publishHeaderError(t("common.copyFailed"), owner);
        }
      });
      return;
    }
    if (action === "reveal" && workspaceRoot) {
      void this.revealHeaderWorkspace(row);
    }
  }

  protected publishHeaderError(error: unknown, owner = this.headerOutcomeOwner): void {
    if (!this.state || !this.ownsHeaderOutcome(owner)) {
      return;
    }
    this.state.chatError = this.state.lastError = formatUiError(error);
  }

  protected async revealHeaderWorkspace(row: GatewaySessionRow): Promise<void> {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    const owner = this.headerOutcomeOwner;
    const agentId = parseAgentSessionKey(row.key)?.agentId;
    try {
      const result = await client.request<SessionsFilesRevealResult>("sessions.files.reveal", {
        key: row.key,
        ...(agentId ? { agentId } : {}),
      });
      if (!result.ok) {
        this.publishHeaderError(result.error ?? "Failed to reveal session workspace.", owner);
      }
    } catch (error) {
      this.publishHeaderError(error, owner);
    }
  }
}
