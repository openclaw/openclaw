import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayErrorDetailCodes } from "../../../../packages/gateway-protocol/src/gateway-error-details.js";
import type {
  ProjectsListResult,
  TaskSuggestion,
  TaskSuggestionEvent,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { ChatPaneSharing } from "./chat-pane-sharing.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import type {
  TaskSuggestionAcceptance,
  TaskSuggestionStartMode,
} from "./components/chat-task-suggestions.tsx";

type TaskSuggestionOperation =
  | { action: "dismiss"; resolved: boolean }
  | {
      action: "accept";
      suggestion: TaskSuggestion;
      mode: TaskSuggestionStartMode;
      cwd?: string;
      canDisplay: () => boolean;
      isCurrent: () => boolean;
      outcome: TaskSuggestionAcceptance;
      clearError?: () => void;
    };

export abstract class ChatPaneTaskSuggestions extends ChatPaneSharing {
  readonly tasks: {
    suggestions: TaskSuggestion[];
    busyIds: Set<string>;
    copiedIds: Set<string>;
    operations: Map<string, TaskSuggestionOperation>;
    activeId: string | undefined;
    swapDirection: "next" | "previous" | undefined;
    swapGeneration: number;
  } = {
    suggestions: [],
    busyIds: new Set(),
    copiedIds: new Set(),
    operations: new Map(),
    activeId: undefined,
    swapDirection: undefined,
    swapGeneration: 0,
  };
  protected taskSuggestionsRequestVersion = 0;
  private explicitReadScope: string | undefined;

  private setTaskSuggestionOperation(id: string, operation: TaskSuggestionOperation | null): void {
    const operations = new Map(this.tasks.operations);
    if (operation) {
      operations.set(id, operation);
    } else {
      operations.delete(id);
    }
    this.tasks.operations = operations;
  }

  protected setTaskSuggestions(suggestions: TaskSuggestion[]): void {
    // Launches and dismissals stay hidden through events and stale list snapshots.
    const visible = suggestions.filter((suggestion) => {
      const operation = this.tasks.operations.get(suggestion.id);
      return !operation || (operation.action === "accept" && operation.outcome.phase === "failed");
    });
    // Keep submitted instructions for recovery, but only failed launches return to the tray.
    for (const operation of this.tasks.operations.values()) {
      if (
        operation.action !== "accept" ||
        !operation.canDisplay() ||
        operation.outcome.phase !== "failed"
      ) {
        continue;
      }
      const index = visible.findIndex((suggestion) => suggestion.id === operation.suggestion.id);
      if (index < 0) {
        visible.push(operation.suggestion);
      } else {
        visible[index] = operation.suggestion;
      }
    }
    this.tasks.suggestions = visible;
    if (!visible.some((suggestion) => suggestion.id === this.tasks.activeId)) {
      this.tasks.activeId = visible[0]?.id;
      this.tasks.swapDirection = undefined;
    }
  }

  protected reconcileTaskSuggestionConnection(resetList: boolean): void {
    const retired = new Set<string>();
    for (const [id, operation] of this.tasks.operations) {
      if (operation.action === "dismiss" ? resetList : !operation.canDisplay()) {
        this.setTaskSuggestionOperation(id, null);
        this.tasks.busyIds.delete(id);
        this.tasks.busyIds = new Set(this.tasks.busyIds);
        retired.add(id);
      } else if (
        operation.action === "accept" &&
        operation.outcome.phase === "starting" &&
        !operation.isCurrent()
      ) {
        operation.outcome = { phase: "failed", error: t("chat.queue.deliveryUnconfirmed") };
        this.setTaskSuggestionOperation(id, operation);
        this.tasks.busyIds.delete(id);
        this.tasks.busyIds = new Set(this.tasks.busyIds);
      }
    }
    this.setTaskSuggestions(
      resetList ? [] : this.tasks.suggestions.filter((suggestion) => !retired.has(suggestion.id)),
    );
  }

  protected readonly navigateTaskSuggestion = (
    taskId: string,
    direction: "next" | "previous",
  ): void => {
    const current = this.tasks.suggestions.findIndex((suggestion) => suggestion.id === taskId);
    if (current < 0 || this.tasks.suggestions.length < 2) {
      return;
    }
    const offset = direction === "next" ? 1 : -1;
    const next =
      this.tasks.suggestions[
        (current + offset + this.tasks.suggestions.length) % this.tasks.suggestions.length
      ];
    if (!next) {
      return;
    }
    this.tasks.activeId = next.id;
    this.tasks.swapDirection = direction;
    this.tasks.swapGeneration += 1;
    void this.updateComplete.then(() => {
      // The suggestion renderer owns the active card and its navigation controls.
      const activeCard = [...this.element.querySelectorAll<HTMLElement>(".task-suggestion")].find(
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
      !canCallGatewayMethod(
        scope.context.gateway.snapshot,
        "taskSuggestions.list",
        "operator.read",
      ) ||
      parseCatalogSessionKey(scope.state.sessionKey)
    ) {
      this.setTaskSuggestions([]);
      return;
    }
    const sessionKey = scope.state.sessionKey;
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
        ...this.tasks.suggestions.filter((item) => item.id !== event.suggestion.id),
      ]);
    } else {
      const operation = this.tasks.operations.get(event.taskId);
      if (operation?.action === "dismiss") {
        operation.resolved = true;
      }
      this.setTaskSuggestions(this.tasks.suggestions.filter((item) => item.id !== event.taskId));
      if (operation?.action !== "accept") {
        this.tasks.busyIds.delete(event.taskId);
        this.tasks.busyIds = new Set(this.tasks.busyIds);
      }
    }
    // The replacement snapshot includes the event plus unrelated suggestions;
    // its request version prevents any older snapshot from overwriting either.
    void this.refreshTaskSuggestions({ automatic: true });
  }

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
      return;
    }
    this.tasks.copiedIds = new Set(this.tasks.copiedIds).add(suggestion.id);
    setTimeout(() => {
      this.tasks.copiedIds.delete(suggestion.id);
      this.tasks.copiedIds = new Set(this.tasks.copiedIds);
    }, 2000);
  };

  protected suggestionChatProps(connected: boolean, archived: boolean, multiIdentity: boolean) {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const auth = gatewaySnapshot.hello?.auth ?? null;
    const canWrite = connected && hasOperatorWriteAccess(auth);
    const canAdmin = connected && hasOperatorAdminAccess(auth);
    const displayedOperations = new Map(this.tasks.operations);
    const ownsDisplayedOperation = (suggestion: TaskSuggestion) => {
      const operation = displayedOperations.get(suggestion.id);
      return (
        operation?.action !== "accept" ||
        (this.tasks.operations.get(suggestion.id) === operation && operation.canDisplay())
      );
    };
    return {
      taskSuggestions: this.tasks.suggestions.filter((suggestion) => {
        const operation = this.tasks.operations.get(suggestion.id);
        return (
          operation?.action !== "accept" ||
          (operation.canDisplay() && operation.outcome.phase === "failed")
        );
      }),
      activeTaskSuggestionId: this.tasks.activeId,
      taskSuggestionSwapDirection: this.tasks.swapDirection,
      taskSuggestionSwapGeneration: this.tasks.swapGeneration,
      onNavigateTaskSuggestion: this.navigateTaskSuggestion,
      taskSuggestionBusyIds: this.tasks.busyIds,
      taskSuggestionAcceptance: (taskId: string) => {
        const operation = this.tasks.operations.get(taskId);
        return operation?.action === "accept" && operation.canDisplay()
          ? operation.outcome
          : undefined;
      },
      sessionSuggestions: multiIdentity ? this.collaboration.suggestions : [],
      sessionSuggestionRole: this.collaboration.role,
      sessionSuggestionBusyIds: this.collaboration.busyIds,
      sessionSuggestionsArchived: archived,
      canResolveSessionSuggestions:
        canWrite &&
        isGatewayMethodAdvertised(gatewaySnapshot, "session.suggestions.resolve") === true,
      onResolveSessionSuggestion: this.resolveCurrentSessionSuggestion.bind(this),
      canAcceptTaskSuggestions:
        canAdmin && isGatewayMethodAdvertised(gatewaySnapshot, "taskSuggestions.accept") === true,
      canDismissTaskSuggestions:
        canWrite && isGatewayMethodAdvertised(gatewaySnapshot, "taskSuggestions.dismiss") === true,
      taskSuggestionCopiedIds: this.tasks.copiedIds,
      onCopyTaskSuggestionPrompt: this.copyTaskSuggestionPrompt,
      onChangeTaskRepository: (
        suggestion: TaskSuggestion,
        patch: { cwd?: string; open?: boolean },
      ) => {
        const operation = this.tasks.operations.get(suggestion.id);
        if (
          ownsDisplayedOperation(suggestion) &&
          operation?.action === "accept" &&
          operation.outcome.phase === "failed" &&
          operation.outcome.repository
        ) {
          Object.assign(operation.outcome.repository, patch);
          this.setTaskSuggestionOperation(suggestion.id, operation);
        }
      },
      onAcceptTaskSuggestion: (
        suggestion: TaskSuggestion,
        mode: TaskSuggestionStartMode,
        cwd?: string,
      ) =>
        ownsDisplayedOperation(suggestion)
          ? this.resolveTaskSuggestion(suggestion, "accept", mode, cwd)
          : undefined,
      onDismissTaskSuggestion: (suggestion: TaskSuggestion) =>
        ownsDisplayedOperation(suggestion)
          ? this.resolveTaskSuggestion(suggestion, "dismiss")
          : undefined,
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
    const previous = this.tasks.operations.get(suggestion.id);
    if (previous?.action === "dismiss") {
      return;
    }
    if (previous?.action === "accept") {
      if (!previous.canDisplay() || previous.outcome.phase === "starting") {
        return;
      }
      if (previous.outcome.phase === "started") {
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
            suggestion: previous?.suggestion ?? suggestion,
            mode: previous?.mode ?? mode,
            cwd: cwd ?? previous?.cwd,
            canDisplay,
            isCurrent: ownsScope,
            outcome: { phase: "starting" },
            clearError: previous?.clearError,
          }
        : { action, resolved: false };
    const originalIndex = this.tasks.suggestions.findIndex((item) => item.id === suggestion.id);
    const isCurrent = () => ownsScope() && this.tasks.operations.get(suggestion.id) === operation;
    this.setTaskSuggestionOperation(suggestion.id, operation);
    if (action === "accept") {
      this.tasks.busyIds = new Set(this.tasks.busyIds).add(suggestion.id);
    }
    this.setTaskSuggestions(this.tasks.suggestions);
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
        operation.outcome = { phase: "started" };
        this.setTaskSuggestionOperation(suggestion.id, operation);
        operation.clearError?.();
        operation.clearError = undefined;
      } else {
        await scope.client.request("taskSuggestions.dismiss", { taskId: suggestion.id });
        if (!isCurrent()) {
          return;
        }
        this.setTaskSuggestions(this.tasks.suggestions.filter((item) => item.id !== suggestion.id));
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
        this.setTaskSuggestionOperation(suggestion.id, operation);
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
              this.setTaskSuggestionOperation(suggestion.id, operation);
            })
            .catch(() => {
              // An explicit path remains usable when the optional project catalog is unavailable.
            });
        }
      }
      if (operation.action === "accept") {
        operation.clearError = scope.state.setRecoverableChatError(formatUiError(error));
      } else {
        scope.state.lastError = formatUiError(error);
        scope.state.chatError = scope.state.lastError;
      }
    } finally {
      if (this.tasks.operations.get(suggestion.id) === operation) {
        if (operation.action === "dismiss") {
          this.setTaskSuggestionOperation(suggestion.id, null);
        }
        this.tasks.busyIds.delete(suggestion.id);
        this.tasks.busyIds = new Set(this.tasks.busyIds);
        if (operation.action === "accept" && !ownsScope()) {
          this.reconcileTaskSuggestionConnection(false);
        }
        if (this.isConnectionScopeCurrent(scope) && scope.state.sessionKey === sessionKey) {
          if (restoreDismissed) {
            if (previous?.action === "accept") {
              this.setTaskSuggestionOperation(suggestion.id, previous);
            }
            const restored = [...this.tasks.suggestions];
            restored.splice(originalIndex, 0, suggestion);
            this.setTaskSuggestions(restored);
          }
          this.setTaskSuggestions(this.tasks.suggestions);
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
