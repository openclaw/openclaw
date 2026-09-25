import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GatewayErrorDetailCodes,
  type ProjectsListResult,
  type TaskSuggestion,
  type TaskSuggestionEvent,
  type TaskSuggestionsAcceptResult,
  type TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import {
  hasOperatorAdminAccess,
  hasOperatorReadAccess,
  hasOperatorWriteAccess,
} from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { ChatPaneSharing } from "./chat-pane-sharing.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import type {
  TaskSuggestionAcceptance,
  TaskSuggestionStartMode,
} from "./components/chat-task-suggestions.ts";

type TaskSuggestionOperation =
  | { action: "dismiss"; resolved: boolean }
  | {
      action: "accept";
      resolved: boolean;
      suggestion: TaskSuggestion;
      mode: TaskSuggestionStartMode;
      cwd?: string;
      canDisplay: () => boolean;
      isCurrent: () => boolean;
      outcome: TaskSuggestionAcceptance;
    };

export abstract class ChatPaneTaskSuggestions extends ChatPaneSharing {
  protected taskSuggestions: TaskSuggestion[] = [];
  protected readonly taskSuggestionBusyIds = new Set<string>();
  protected readonly taskSuggestionCopiedIds = new Set<string>();
  protected readonly taskSuggestionOperations = new Map<string, TaskSuggestionOperation>();
  protected taskSuggestionsRequestVersion = 0;
  protected activeTaskSuggestionId: string | undefined;
  protected taskSuggestionSwapDirection: "next" | "previous" | undefined;
  protected taskSuggestionSwapGeneration = 0;
  private explicitReadScope: string | undefined;

  protected setTaskSuggestions(suggestions: TaskSuggestion[]): void {
    // Pending dismissals stay hidden when events or list snapshots arrive.
    const visible = suggestions.filter(
      (suggestion) => this.taskSuggestionOperations.get(suggestion.id)?.action !== "dismiss",
    );
    // Acceptance owns its submitted prompt through early resolved events and list snapshots.
    for (const operation of this.taskSuggestionOperations.values()) {
      if (operation.action !== "accept" || !operation.canDisplay()) {
        continue;
      }
      const index = visible.findIndex((suggestion) => suggestion.id === operation.suggestion.id);
      if (index < 0) {
        visible.push(operation.suggestion);
      } else {
        visible[index] = operation.suggestion;
      }
    }
    this.taskSuggestions = visible;
    if (!visible.some((suggestion) => suggestion.id === this.activeTaskSuggestionId)) {
      this.activeTaskSuggestionId = visible[0]?.id;
      this.taskSuggestionSwapDirection = undefined;
    }
  }

  protected reconcileTaskSuggestionConnection(resetList: boolean): void {
    const retired = new Set<string>();
    for (const [id, operation] of this.taskSuggestionOperations) {
      if (operation.action === "dismiss" ? resetList : !operation.canDisplay()) {
        this.taskSuggestionOperations.delete(id);
        this.taskSuggestionBusyIds.delete(id);
        retired.add(id);
      } else if (
        operation.action === "accept" &&
        operation.outcome.phase === "starting" &&
        !operation.isCurrent()
      ) {
        operation.outcome = { phase: "failed", error: t("chat.queue.deliveryUnconfirmed") };
        this.taskSuggestionBusyIds.delete(id);
      }
    }
    this.setTaskSuggestions(
      resetList ? [] : this.taskSuggestions.filter((suggestion) => !retired.has(suggestion.id)),
    );
  }

  protected readonly navigateTaskSuggestion = (
    taskId: string,
    direction: "next" | "previous",
  ): void => {
    const current = this.taskSuggestions.findIndex((suggestion) => suggestion.id === taskId);
    if (current < 0 || this.taskSuggestions.length < 2) {
      return;
    }
    const offset = direction === "next" ? 1 : -1;
    const next =
      this.taskSuggestions[
        (current + offset + this.taskSuggestions.length) % this.taskSuggestions.length
      ];
    if (!next) {
      return;
    }
    this.activeTaskSuggestionId = next.id;
    this.taskSuggestionSwapDirection = direction;
    this.taskSuggestionSwapGeneration += 1;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const activeCard = [...this.querySelectorAll<HTMLElement>(".task-suggestion")].find(
        (card) => card.dataset.taskId === next.id,
      );
      activeCard
        ?.querySelector<HTMLElement>(`[data-task-${direction === "next" ? "next" : "prev"}]`)
        ?.focus();
    });
  };

  protected async refreshTaskSuggestions(options?: { automatic?: boolean }): Promise<void> {
    const requestVersion = ++this.taskSuggestionsRequestVersion;
    const scope = this.captureConnectionScope();
    if (
      !scope ||
      !isGatewayMethodAdvertised(scope.context.gateway.snapshot, "taskSuggestions.list")
    ) {
      this.setTaskSuggestions([]);
      this.requestUpdate();
      return;
    }
    const sessionKey = scope.state.sessionKey;
    if (parseCatalogSessionKey(sessionKey)) {
      this.setTaskSuggestions([]);
      this.requestUpdate();
      return;
    }
    const agentId = resolveChatAgentId(scope.state);
    const readScope = JSON.stringify([this.connectionGeneration, sessionKey, agentId]);
    if (options?.automatic) {
      if (!this.secondarySessionReadsReady(this.explicitReadScope === readScope)) {
        return;
      }
    } else {
      this.explicitReadScope = readScope;
    }
    try {
      const result = await scope.client.request<TaskSuggestionsListResult>("taskSuggestions.list", {
        agentId,
      });
      if (
        requestVersion !== this.taskSuggestionsRequestVersion ||
        !this.isConnectionScopeCurrent(scope) ||
        sessionKey !== scope.state.sessionKey
      ) {
        return;
      }
      this.setTaskSuggestions(
        result.suggestions.filter((suggestion) => this.suggestionMatchesCurrentSession(suggestion)),
      );
      this.requestUpdate();
    } catch {
      // Suggestions are an optional ephemeral affordance; chat remains usable
      // when a reconnect loses the process-local registry.
      // Keep event-delivered cards when a background reconciliation fails.
    }
  }

  protected handleTaskSuggestionEvent(event: TaskSuggestionEvent): void {
    if (event.action === "created") {
      if (!this.suggestionMatchesCurrentSession(event.suggestion)) {
        return;
      }
      this.setTaskSuggestions([
        event.suggestion,
        ...this.taskSuggestions.filter((item) => item.id !== event.suggestion.id),
      ]);
    } else {
      const operation = this.taskSuggestionOperations.get(event.taskId);
      if (operation) {
        operation.resolved = true;
      }
      this.setTaskSuggestions(this.taskSuggestions.filter((item) => item.id !== event.taskId));
      if (operation?.action !== "accept") {
        this.taskSuggestionBusyIds.delete(event.taskId);
      }
    }
    this.requestUpdate();
    // The replacement snapshot includes the event plus unrelated suggestions;
    // its request version prevents any older snapshot from overwriting either.
    void this.refreshTaskSuggestions({ automatic: true });
  }

  protected readonly acceptTaskSuggestion = (
    suggestion: TaskSuggestion,
    mode: TaskSuggestionStartMode = "local",
    cwd?: string,
  ): Promise<void> => this.resolveTaskSuggestion(suggestion, "accept", mode, cwd);

  protected readonly dismissTaskSuggestion = (suggestion: TaskSuggestion): Promise<void> =>
    this.resolveTaskSuggestion(suggestion, "dismiss");

  // Copy is client-local and never gated on acceptance capability; a failed
  // copy must surface visibly instead of dissolving into silence.
  protected readonly copyTaskSuggestionPrompt = async (
    suggestion: TaskSuggestion,
  ): Promise<void> => {
    const copied = await copyToClipboard(suggestion.prompt);
    if (!this.isConnected) {
      return;
    }
    if (!copied) {
      const failure = t("chat.taskSuggestions.copyPromptFailed");
      if (this.state) {
        this.state.lastError = failure;
        this.state.chatError = failure;
      }
      this.requestUpdate();
      return;
    }
    this.taskSuggestionCopiedIds.add(suggestion.id);
    this.requestUpdate();
    setTimeout(() => {
      this.taskSuggestionCopiedIds.delete(suggestion.id);
      if (this.isConnected) {
        this.requestUpdate();
      }
    }, 2000);
  };

  protected suggestionChatProps(connected: boolean, archived: boolean, multiIdentity: boolean) {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const auth = gatewaySnapshot.hello?.auth ?? null;
    const canWrite = connected && hasOperatorWriteAccess(auth);
    const canAdmin = connected && hasOperatorAdminAccess(auth);
    const displayedOperations = new Map(this.taskSuggestionOperations);
    const ownsDisplayedOperation = (suggestion: TaskSuggestion) => {
      const operation = displayedOperations.get(suggestion.id);
      return (
        operation?.action !== "accept" ||
        (this.taskSuggestionOperations.get(suggestion.id) === operation && operation.canDisplay())
      );
    };
    return {
      taskSuggestions: this.taskSuggestions.filter((suggestion) => {
        const operation = this.taskSuggestionOperations.get(suggestion.id);
        return operation?.action !== "accept" || operation.canDisplay();
      }),
      activeTaskSuggestionId: this.activeTaskSuggestionId,
      taskSuggestionSwapDirection: this.taskSuggestionSwapDirection,
      taskSuggestionSwapGeneration: this.taskSuggestionSwapGeneration,
      onNavigateTaskSuggestion: this.navigateTaskSuggestion,
      taskSuggestionBusyIds: this.taskSuggestionBusyIds,
      taskSuggestionAcceptance: (taskId: string) => {
        const operation = this.taskSuggestionOperations.get(taskId);
        return operation?.action === "accept" && operation.canDisplay()
          ? operation.outcome
          : undefined;
      },
      canOpenTaskSuggestions:
        connected && gatewaySnapshot.phase === "connected" && hasOperatorReadAccess(auth),
      onOpenTaskSuggestion: this.onPaneSessionChange
        ? (suggestion: TaskSuggestion) => {
            const operation = this.taskSuggestionOperations.get(suggestion.id);
            const snapshot = this.context.gateway.snapshot;
            if (
              snapshot.phase === "connected" &&
              hasOperatorReadAccess(snapshot.hello?.auth ?? null) &&
              ownsDisplayedOperation(suggestion) &&
              operation?.action === "accept" &&
              operation.canDisplay() &&
              operation.outcome.phase === "started"
            ) {
              this.onPaneSessionChange?.(this.paneId, operation.outcome.sessionKey);
            }
          }
        : undefined,
      sessionSuggestions: multiIdentity ? this.sessionSuggestions : [],
      sessionSuggestionRole: this.sessionSuggestionRole,
      sessionSuggestionBusyIds: this.sessionSuggestionBusyIds,
      sessionSuggestionsArchived: archived,
      canResolveSessionSuggestions:
        canWrite &&
        isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.resolve") === true,
      onResolveSessionSuggestion: this.resolveCurrentSessionSuggestion.bind(this),
      canAcceptTaskSuggestions:
        canAdmin && isGatewayMethodAdvertised(gatewaySnapshot, "taskSuggestions.accept") === true,
      canDismissTaskSuggestions:
        canWrite && isGatewayMethodAdvertised(gatewaySnapshot, "taskSuggestions.dismiss") === true,
      taskSuggestionCopiedIds: this.taskSuggestionCopiedIds,
      onCopyTaskSuggestionPrompt: this.copyTaskSuggestionPrompt,
      onChangeTaskRepository: (
        suggestion: TaskSuggestion,
        patch: { cwd?: string; open?: boolean },
      ) => {
        const operation = this.taskSuggestionOperations.get(suggestion.id);
        if (
          ownsDisplayedOperation(suggestion) &&
          operation?.action === "accept" &&
          operation.outcome.phase === "failed" &&
          operation.outcome.repository
        ) {
          Object.assign(operation.outcome.repository, patch);
          this.requestUpdate();
        }
      },
      onAcceptTaskSuggestion: (
        suggestion: TaskSuggestion,
        mode: TaskSuggestionStartMode,
        cwd?: string,
      ) => {
        return ownsDisplayedOperation(suggestion)
          ? this.acceptTaskSuggestion(suggestion, mode, cwd)
          : undefined;
      },
      onDismissTaskSuggestion: (suggestion: TaskSuggestion) => {
        return ownsDisplayedOperation(suggestion)
          ? this.dismissTaskSuggestion(suggestion)
          : undefined;
      },
    };
  }

  protected async resolveTaskSuggestion(
    suggestion: TaskSuggestion,
    action: "accept" | "dismiss",
    mode: TaskSuggestionStartMode = "local",
    cwd?: string,
  ): Promise<void> {
    const scope = this.captureConnectionScope();
    if (!scope || !this.suggestionMatchesCurrentSession(suggestion)) {
      return;
    }
    const previous = this.taskSuggestionOperations.get(suggestion.id);
    if (previous?.action === "dismiss") {
      return;
    }
    if (previous?.action === "accept") {
      if (!previous.canDisplay() || previous.outcome.phase === "starting") {
        return;
      }
      if (previous.outcome.phase === "started") {
        if (action === "dismiss") {
          this.taskSuggestionsRequestVersion += 1;
          this.taskSuggestionOperations.delete(suggestion.id);
          this.setTaskSuggestions(this.taskSuggestions.filter((item) => item.id !== suggestion.id));
          this.requestUpdate();
        }
        return;
      }
    }
    const snapshot = scope.context.gateway.snapshot;
    const auth = snapshot.hello?.auth ?? null;
    if (
      !isGatewayMethodAdvertised(snapshot, `taskSuggestions.${action}`) ||
      !(action === "accept" ? hasOperatorAdminAccess(auth) : hasOperatorWriteAccess(auth))
    ) {
      return;
    }
    const sessionKey = scope.state.sessionKey;
    let physicalSessionId = normalizeOptionalString(scope.state.currentSessionId);
    let physicalSessionRetired = false;
    const presentationScope = gatewayPresentationScope(scope.context.gateway);
    let recoveryScope =
      snapshot.hello?.auth?.recoveryScope ??
      (scope.client.recoveryScopeReady ? scope.client.recoveryScope : undefined);
    const canDisplay = () => {
      const currentSessionId = normalizeOptionalString(scope.state.currentSessionId);
      // Bind late hydration once; replacing a physical session permanently retires its receipt.
      physicalSessionId ??= currentSessionId;
      physicalSessionRetired ||=
        Boolean(physicalSessionId && currentSessionId) && currentSessionId !== physicalSessionId;
      const current = scope.context.gateway.snapshot;
      const currentScope =
        current.hello?.auth?.recoveryScope ??
        (current.client?.recoveryScopeReady ? current.client.recoveryScope : undefined);
      recoveryScope ??= currentScope;
      return (
        this.isConnected &&
        this.context === scope.context &&
        this.state === scope.state &&
        scope.state.sessionKey === sessionKey &&
        !physicalSessionRetired &&
        gatewayPresentationScope(scope.context.gateway) === presentationScope &&
        (!currentScope || currentScope === recoveryScope)
      );
    };
    const ownsScope = () => this.isConnectionScopeCurrent(scope) && canDisplay();
    const operation: TaskSuggestionOperation =
      action === "accept"
        ? {
            action,
            resolved: false,
            suggestion: previous?.suggestion ?? suggestion,
            mode: previous?.mode ?? mode,
            cwd: cwd ?? previous?.cwd,
            canDisplay,
            isCurrent: ownsScope,
            outcome: { phase: "starting" },
          }
        : { action, resolved: false };
    const originalIndex = this.taskSuggestions.findIndex((item) => item.id === suggestion.id);
    const isCurrent = () =>
      ownsScope() && this.taskSuggestionOperations.get(suggestion.id) === operation;
    this.taskSuggestionOperations.set(suggestion.id, operation);
    if (action === "accept") {
      this.taskSuggestionBusyIds.add(suggestion.id);
    }
    this.setTaskSuggestions(this.taskSuggestions);
    this.requestUpdate();
    let restoreDismissed = false;
    try {
      if (operation.action === "accept") {
        const result = await scope.client.request<TaskSuggestionsAcceptResult>(
          "taskSuggestions.accept",
          {
            taskId: suggestion.id,
            mode: operation.mode,
            ...(operation.cwd ? { cwd: operation.cwd } : {}),
          },
        );
        if (!isCurrent()) {
          return;
        }
        const key = normalizeOptionalString(result.key);
        if (result.taskId !== suggestion.id || !key) {
          throw new Error(t("chat.taskSuggestions.startUnconfirmed"));
        }
        operation.outcome = {
          phase: "started",
          sessionKey: key,
          href: sessionNavigationTarget({
            face: "chat",
            sessionKey: key,
            fallbackAgentId: suggestion.agentId ?? resolveChatAgentId(scope.state),
            basePath: scope.context.basePath,
            exactKey: true,
          }).href,
        };
      } else {
        await scope.client.request("taskSuggestions.dismiss", { taskId: suggestion.id });
        if (!isCurrent()) {
          return;
        }
        this.setTaskSuggestions(this.taskSuggestions.filter((item) => item.id !== suggestion.id));
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      if (operation.action === "dismiss") {
        // A resolved event confirms removal even if its RPC response was lost.
        if (operation.resolved) {
          return;
        }
        restoreDismissed = originalIndex >= 0;
      } else {
        const details = error instanceof GatewayRequestError ? error.details : undefined;
        const repositoryRequired =
          operation.mode === "worktree" &&
          details &&
          typeof details === "object" &&
          "code" in details &&
          details.code === GatewayErrorDetailCodes.TASK_WORKTREE_SOURCE_REQUIRED;
        const repository: Extract<TaskSuggestionAcceptance, { phase: "failed" }>["repository"] =
          repositoryRequired
            ? { cwd: operation.cwd ?? operation.suggestion.cwd, open: true, projects: [] }
            : undefined;
        operation.outcome = {
          phase: "failed",
          error: formatUiError(error),
          ...(repository ? { repository } : {}),
        };
        if (repository) {
          void scope.client
            .request<ProjectsListResult>("projects.list", {})
            .then((result) => {
              if (
                !isCurrent() ||
                operation.outcome.phase !== "failed" ||
                operation.outcome.repository !== repository
              ) {
                return;
              }
              repository.projects = result.projects.filter((project) => Boolean(project.repoRoot));
              this.requestUpdate();
            })
            .catch(() => {
              // An explicit path remains usable when the optional project catalog is unavailable.
            });
        }
      }
      scope.state.lastError = formatUiError(error);
      scope.state.chatError = scope.state.lastError;
    } finally {
      if (this.taskSuggestionOperations.get(suggestion.id) === operation) {
        if (operation.action === "dismiss") {
          this.taskSuggestionOperations.delete(suggestion.id);
        }
        this.taskSuggestionBusyIds.delete(suggestion.id);
        if (operation.action === "accept" && !ownsScope()) {
          this.reconcileTaskSuggestionConnection(false);
          this.requestUpdate();
        }
        if (this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
          if (restoreDismissed) {
            if (previous?.action === "accept") {
              this.taskSuggestionOperations.set(suggestion.id, previous);
            }
            const restored = [...this.taskSuggestions];
            restored.splice(originalIndex, 0, suggestion);
            this.setTaskSuggestions(restored);
          }
          this.requestUpdate();
          if (action === "dismiss") {
            // Replace stale reads after every outcome, including refused dismissals,
            // so another card's completion cannot discard their reconciliation.
            void this.refreshTaskSuggestions();
          }
        }
      }
    }
  }
}
