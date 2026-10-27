import { createMemo, lazy, Show, untrack } from "solid-js";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import { isChatRunWorking } from "../chat-run-working.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const ChatQueue = lazy(() => import("./chat-composer-queue.tsx"), {
  export: "renderChatQueueSolid",
});
const SessionProgressCard = lazy(
  () => import("../../../components/session-progress-card-solid.tsx"),
  {
    export: "SessionProgressCard",
  },
);

export function ComposerQueue(view: { composer: ChatComposerProps; showAbortableUi: boolean }) {
  const canAct = () =>
    view.composer.connected && view.composer.canSend && !view.composer.submitDisabledReason;
  return (
    <Show
      when={
        view.composer.queue.length ||
        view.composer.displayQueue?.length ||
        view.composer.queuedEdit?.source
      }
    >
      <ChatLazyBoundary>
        <ChatQueue
          queue={view.composer.queue}
          runId={view.composer.runId}
          displayQueue={view.composer.displayQueue}
          connected={view.composer.connected}
          offline={view.composer.offline}
          canAbort={view.showAbortableUi}
          canRemoveServerQueued={canAct()}
          onQueueRetry={canAct() ? view.composer.onQueueRetry : undefined}
          onQueueSteer={canAct() ? view.composer.onQueueSteer : undefined}
          onQueueMove={view.composer.onQueueMove}
          queuedEdit={view.composer.queuedEdit}
          onQueueRemove={view.composer.onQueueRemove}
        />
      </ChatLazyBoundary>
    </Show>
  );
}

export function ComposerInputScope(props: { children: import("@solidjs/web").JSX.Element }) {
  // This scope retains one native input subtree, including its focus and undo history.
  const initialChildren = untrack(() => props.children);
  return initialChildren;
}

export function ComposerProgress(view: { composer: ChatComposerProps; shown: boolean }) {
  const visibility = createMemo(() =>
    projectPresentation(view.composer.progressCardVisibility ?? true),
  );
  const presented = () => visibility().read();
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
        <ChatLazyBoundary>
          <SessionProgressCard
            card={view.composer.progressCard}
            placement="composer"
            onDismiss={view.composer.onDismissProgressCard}
            sessionStatus={view.composer.selectedSession?.status}
            startedAt={view.composer.selectedSession?.startedAt}
            endedAt={view.composer.selectedSession?.endedAt}
            hasActiveRun={isChatRunWorking(view.composer)}
            collapseComposerByDefault={view.composer.collapseTaskProgress}
            composerDisclosureContext={{
              presented: view.shown,
              gatewayScope: view.composer.gatewayScope,
              sessionIdentity: view.composer.progressCardIdentity,
              cardLifetime: view.composer.progressCardLifetime,
              readingHistory: view.composer.readingHistory,
              getTranscriptElement: view.composer.getTranscriptElement,
              onManipulate: view.composer.onProgressManipulate,
            }}
            refreshAction={
              view.composer.connected && view.composer.canSend
                ? view.composer.progressCardRefresh
                : undefined
            }
            onClearSaved={view.composer.onClearSavedProgressCard}
          />
        </ChatLazyBoundary>
      </div>
    </Show>
  );
}
