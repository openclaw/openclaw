import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { isSessionRunActive } from "../lib/session-run-state.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import {
  CHAT_PANE_LIFECYCLE_CHANGED_EVENT,
  CHAT_RUN_ACTIVITY_CHANGED_EVENT,
} from "../pages/chat/chat-history-events.ts";
import type { ChatPaneBase } from "../pages/chat/chat-pane-base.ts";
import type { ChatRunUiStatus } from "../pages/chat/run-lifecycle.ts";
import type { ApplicationContext } from "./context.ts";
import {
  applyControlUiFaviconStatus,
  invalidateControlUiFaviconPalette,
} from "./control-ui-environment-presentation.runtime.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";
import {
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  listQuestionPrompts,
  refreshPendingQuestionsWithRetry,
  setQuestionPromptClient,
} from "./question-prompt.ts";

export function connectControlUiFavicon(
  shell: HTMLElement,
  context: Pick<ApplicationContext, "gateway" | "agentSelection" | "sessions" | "overlays">,
  startedAt = Date.now(),
): () => void {
  invalidateControlUiFaviconPalette();
  let scopeStartedAt = startedAt;
  let disposed = false;
  let unread = false;
  let client = context.gateway.snapshot.client;
  let agentId = context.agentSelection.state.selectedId;
  let scope = gatewayPresentationScope(context.gateway);
  let activeRosterSessions = new Map<string, string | undefined>();
  const seenCompletions = new WeakSet<ChatRunUiStatus>();
  let questions = createQuestionPromptState(() => synchronize());

  function synchronizeScope() {
    const snapshot = context.gateway.snapshot;
    const nextScope = gatewayPresentationScope(context.gateway);
    const nextAgentId = context.agentSelection.state.selectedId;
    if (
      scope !== nextScope ||
      (snapshot.client && questions.ownerClient && snapshot.client !== questions.ownerClient)
    ) {
      disposeQuestionPromptState(questions);
      questions = createQuestionPromptState(() => synchronize());
    }
    if (client !== snapshot.client || agentId !== nextAgentId || scope !== nextScope) {
      unread = false;
      activeRosterSessions.clear();
      scopeStartedAt = Date.now();
      client = snapshot.client;
      agentId = nextAgentId;
      scope = nextScope;
    }
  }

  function synchronize() {
    if (disposed) {
      return;
    }
    synchronizeScope();
    const snapshot = context.gateway.snapshot;
    let working = false;
    for (const pane of shell.querySelectorAll<ChatPaneBase>("openclaw-chat-pane")) {
      const activity = pane.runActivity;
      const completion = activity?.completion;
      const unseen = completion && !seenCompletions.has(completion);
      if (completion) {
        seenCompletions.add(completion);
      }
      if (!activity || activity.client !== client || activity.agentId !== agentId) {
        continue;
      }
      working ||= activity.working;
      if (
        unseen &&
        completion.phase === "done" &&
        completion.occurredAt >= scopeStartedAt &&
        document.visibilityState === "hidden"
      ) {
        unread = true;
      }
    }
    const sessionResult = context.sessions.state.result;
    // Reconnect hydration can temporarily leave the roster unavailable.
    if (snapshot.phase === "connected" && sessionResult) {
      const nextActive = new Map<string, string | undefined>();
      for (const row of sessionResult.sessions) {
        const rowAgent = normalizeAgentId(
          row.agentId ??
            parseAgentSessionKey(row.key)?.agentId ??
            context.sessions.state.agentId ??
            "",
        );
        if (rowAgent !== agentId) {
          continue;
        }
        if (isSessionRunActive(row)) {
          working = true;
          nextActive.set(row.key, row.sessionId);
        } else if (
          row.status === "done" &&
          activeRosterSessions.has(row.key) &&
          activeRosterSessions.get(row.key) === row.sessionId &&
          document.visibilityState === "hidden"
        ) {
          unread = true;
        }
      }
      // Only an observed active session becoming authoritatively done is unread;
      // list eviction, failure, and old completed rows do not announce completion.
      activeRosterSessions = nextActive;
    }
    if (document.visibilityState === "visible") {
      unread = false;
    }
    const attention =
      context.overlays.snapshot.approvalQueue.length > 0 ||
      listQuestionPrompts(questions).some((question) => question.status === "pending");
    applyControlUiFaviconStatus(
      attention
        ? "attention"
        : working
          ? "working"
          : unread
            ? "done"
            : snapshot.phase !== "connected"
              ? "disconnected"
              : "idle",
    );
  }

  function synchronizeGateway() {
    synchronizeScope();
    const snapshot = context.gateway.snapshot;
    const questionClient =
      snapshot.phase === "connected" &&
      isGatewayMethodAdvertised({ hello: snapshot.hello }, "question.list")
        ? snapshot.client
        : null;
    if (questions.client !== questionClient) {
      setQuestionPromptClient(questions, questionClient);
      if (questionClient) {
        refreshPendingQuestionsWithRetry(
          questions,
          questionClient,
          () =>
            !disposed &&
            context.gateway.snapshot.client === questionClient &&
            context.gateway.snapshot.phase === "connected",
        );
      }
    }
    synchronize();
  }

  const stops = [
    context.gateway.subscribe(synchronizeGateway),
    context.gateway.subscribeEvents((event) => handleQuestionPromptEvent(questions, event)),
    context.overlays.subscribe(synchronize),
    context.agentSelection.subscribe(synchronize),
    context.sessions.subscribe(synchronize),
  ];
  const palette = new MutationObserver(() => {
    invalidateControlUiFaviconPalette();
    synchronize();
  });
  palette.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "data-theme", "data-theme-mode"],
  });
  document.addEventListener("visibilitychange", synchronize);
  shell.addEventListener(CHAT_RUN_ACTIVITY_CHANGED_EVENT, synchronize);
  shell.addEventListener(CHAT_PANE_LIFECYCLE_CHANGED_EVENT, synchronize);
  synchronizeGateway();
  return () => {
    disposed = true;
    stops.forEach((stop) => stop());
    palette.disconnect();
    document.removeEventListener("visibilitychange", synchronize);
    shell.removeEventListener(CHAT_RUN_ACTIVITY_CHANGED_EVENT, synchronize);
    shell.removeEventListener(CHAT_PANE_LIFECYCLE_CHANGED_EVENT, synchronize);
    disposeQuestionPromptState(questions);
    applyControlUiFaviconStatus("idle");
  };
}
