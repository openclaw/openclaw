import { createRenderEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../../lit/presentation-binding.ts";
import type { GoalComposerController } from "./chat-composer-goal-mode.tsx";
import { ChatGoal } from "./chat-composer-goal.tsx";
import { LitContent } from "./chat-composer-interop.tsx";
import { renderChatQueueSolid as ChatQueue } from "./chat-composer-queue.tsx";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function ComposerQueue(view: { composer: ChatComposerProps; showAbortableUi: boolean }) {
  const canAct = () =>
    view.composer.connected && view.composer.canSend && !view.composer.submitDisabledReason;
  return (
    <ChatQueue
      queue={view.composer.queue}
      displayQueue={view.composer.displayQueue}
      offline={view.composer.offline}
      canAbort={view.showAbortableUi}
      canRemoveServerQueued={canAct()}
      onQueueRetry={canAct() ? view.composer.onQueueRetry : undefined}
      onQueueSteer={canAct() ? view.composer.onQueueSteer : undefined}
      onQueueMove={view.composer.onQueueMove}
      queuedEdit={view.composer.queuedEdit}
      onQueueRemove={view.composer.onQueueRemove}
    />
  );
}

export function ComposerInputScope(props: {
  state: ChatComposerState;
  children: import("@solidjs/web").JSX.Element;
}) {
  const state = untrack(() => props.state);
  onCleanup(() => {
    state.textareaRef?.();
    state.composerInputRef?.();
  });
  return untrack(() => props.children);
}

export function ComposerProgress(view: { composer: ChatComposerProps; shown: boolean }) {
  const [revision, setRevision] = createSignal(0);
  createRenderEffect(
    () => view.composer.progressCardVisibility,
    (binding) => {
      if (!binding) {
        return undefined;
      }
      const changed = () => setRevision((value) => value + 1);
      binding.owner.addEventListener(PRESENTATION_CHANGED_EVENT, changed);
      return () => binding.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, changed);
    },
  );
  const presented = () => {
    revision();
    return view.composer.progressCardVisibility?.isPresented() ?? true;
  };
  return (
    <Show
      when={presented() && Boolean(view.composer.progressCard)}
      fallback={
        presented() && view.composer.progressCardInitialLoading ? (
          <div
            class="agent-chat__progress-float agent-chat__progress-float--loading"
            hidden={!view.shown}
            aria-hidden="true"
          />
        ) : undefined
      }
    >
      <div class="agent-chat__progress-float" hidden={!view.shown}>
        <LitContent
          value={renderSessionProgressCard(
            view.composer.progressCard,
            "composer",
            view.composer.onDismissProgressCard,
            view.composer.selectedSession?.status,
            view.composer.selectedSession?.startedAt,
            view.composer.selectedSession?.endedAt,
            view.composer.runActive,
            view.composer.collapseTaskProgress,
            {
              presented: view.shown,
              gatewayScope: view.composer.gatewayScope,
              sessionIdentity: view.composer.progressCardIdentity,
              cardLifetime: view.composer.progressCardLifetime,
              readingHistory: view.composer.readingHistory,
              onManipulate: view.composer.onProgressManipulate,
            },
            view.composer.connected && view.composer.canSend
              ? view.composer.progressCardRefresh
              : undefined,
            view.composer.onClearSavedProgressCard,
          )}
        />
      </div>
    </Show>
  );
}

export function ComposerGoal(view: {
  composer: ChatComposerProps;
  state: ChatComposerState;
  controller: GoalComposerController;
  requestUpdate: () => void;
}) {
  return (
    <Show when={view.composer.selectedSession?.goal} keyed>
      {(goal) => (
        <div class="agent-chat__goal-float">
          <ChatGoal
            goal={goal}
            expanded={view.state.goalExpandedId === goal.id}
            canAct={
              view.composer.connected &&
              view.composer.canSend &&
              !view.composer.submitDisabledReason &&
              Boolean(view.composer.currentSessionId) &&
              !view.composer.goalRecovery
            }
            onGoalAction={view.composer.onGoalAction}
            onGoalEdit={
              view.composer.onGoalSubmit ? (selected) => view.controller.begin(selected) : undefined
            }
            onExpandedChange={(expanded) => {
              view.state.goalExpandedId = expanded ? goal.id : null;
              view.requestUpdate();
            }}
          />
        </div>
      )}
    </Show>
  );
}
