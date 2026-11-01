import type {
  SessionsFilesRevealResult,
  WorktreesBranchesResult,
  WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "../../components/app-sidebar-session-types.ts";
import { hasModalSurface } from "../../components/overlay-registry.ts";
import {
  captureSessionMutationScope,
  isSessionMutationScopeCurrent,
} from "../../components/session-mutation-scope.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badge-presentation.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
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
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { readSystemInfo } from "../../lib/system-info.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { ChatPaneContext } from "./chat-pane-context.ts";
import { chatSessionPresentationTitle } from "./chat-pane-session-presentation.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { ChatPaneHeaderAction } from "./components/chat-pane-header.types.ts";
import { buildContinueInTerminalCommand } from "./continue-in-terminal-command.ts";

registerChatSessionEnglish();

export abstract class ChatPaneSessionMenu extends ChatPaneContext {
  resolveHeaderSessionTitle(row: GatewaySessionRow | undefined): string {
    const state = this.state;
    const hydration = state && chatHistoryRequests(state).initialSnapshotHydration;
    const session = row ?? this.resourceSessionObservation()?.row ?? undefined;
    const created = this.context.chatSubmissions.readAcceptedCreate();
    return chatSessionPresentationTitle(
      state,
      session ?? this.transcriptSessionProps(session).transcriptMetadata,
      this.sessionKey,
      Boolean(
        hydration?.titlePending &&
        areUiSessionKeysEquivalent(hydration.sessionKey, this.sessionKey),
      ),
      created && areUiSessionKeysEquivalent(created.creation.sessionKey, this.sessionKey)
        ? created.displayName
        : undefined,
    );
  }

  canArchiveHeaderSession(row: GatewaySessionRow): boolean {
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
      readSessionMethodAccess(this.context.gateway.snapshot, {
        method: "sessions.patch",
        params: { key: row.key, archived: true },
        sessionScope: true,
        session: row,
        allowDeferred: true,
      }).allowed
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
      !state ||
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
    const scope = this.captureHeaderSessionActionScope(true);
    if (!scope) {
      this.publishHeaderError(t("sessionsView.actionRequiresConnection"));
      return true;
    }
    const owner = this.headerOutcomeOwner;
    const draftSignal = this.headerSessionDraftAbortController.signal;
    const capturedRow = { ...row };
    void (async () => {
      try {
        const { runHeaderSessionMutation } = await import("./chat-pane-session-menu-actions.ts");
        await runHeaderSessionMutation(this, { kind: "toggle-archived" }, capturedRow, {
          scope,
          owner,
          draftSignal,
        });
      } catch (error) {
        if (this.isHeaderSessionActionCurrent(scope, owner)) {
          this.publishHeaderError(error, owner);
        }
      }
    })();
    return true;
  };

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

  async openHeaderSessionGroup(
    moveToGroup: (name: string) => Promise<SidebarSessionMutationResult | void>,
  ): Promise<void> {
    const signal = this.headerSessionDraftAbortController.signal;
    const gateway = this.context.gateway;
    const owner = this.headerOutcomeOwner;
    try {
      const { showInputDialog } = await import("../../components/input-dialog.tsx");
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
              : (this.state?.chatError ?? t("sessionsView.newGroupFailed"));
        },
      });
    } catch (error) {
      this.publishHeaderError(error, owner);
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

  openContinueInTerminalDialog(row: GatewaySessionRow): void {
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

  captureHeaderSessionActionScope(
    allowDeferred = false,
  ): (SidebarSessionMutationScope & { signal: AbortSignal }) | null {
    return captureSessionMutationScope(this.context, {
      epoch: this.connectionGeneration,
      allowDeferred,
      selectedAgentId: this.context.agentSelection.state.selectedId ?? "main",
      signal: this.headerSessionMutationAbortController.signal,
    });
  }

  isHeaderSessionActionCurrent(scope: SidebarSessionMutationScope, owner: string): boolean {
    return this.ownsHeaderOutcome(owner) && isSessionMutationScopeCurrent(this.context, scope);
  }

  beginHeaderRename(row: GatewaySessionRow): void {
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
    if (
      !row.worktree &&
      !remote &&
      knownRoot &&
      rootMayHaveBranch &&
      hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null)
    ) {
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

  publishHeaderError(error: unknown, owner = this.headerOutcomeOwner): void {
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
