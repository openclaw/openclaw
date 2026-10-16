import { createSignal, onCleanup, onSettled } from "solid-js";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { notifyRenderLifecycleForTest } from "./render-lifecycle.ts";

/** Owns the Solid publication and commit lifetime of one synchronous pane. */
export function createChatPane({ runtime }: { runtime: ChatPaneRuntime }) {
  const [ready, setReady] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  let disposed = false;
  let publicationQueued = false;
  let complete: (() => void) | undefined;
  let previousInputs:
    | Pick<ChatPaneRuntime, "sessionKey" | "inputRegion" | "draft" | "focusComposer">
    | undefined;
  let focusPending = false;

  function publish() {
    if (disposed || !publicationQueued) {
      return;
    }
    runtime.refreshBoardSubscriptions();
    publicationQueued = false;
    setRevision((value) => value + 1);
    if (runtime.presented && document.visibilityState !== "hidden") {
      notifyRenderLifecycleForTest(runtime.element, "invalidate");
    }
  }

  runtime.invalidate = () => {
    if (disposed || !runtime.isConnected) {
      return;
    }
    if (!complete) {
      runtime.updateComplete = new Promise<boolean>((resolve) => {
        complete = () => resolve(true);
      });
    }
    if (!publicationQueued) {
      publicationQueued = true;
      // Domain mutations stay synchronous; rendering retains its microtask boundary.
      queueMicrotask(publish);
    }
  };

  onSettled(() => {
    if (!runtime.isConnected) {
      runtime.start();
    }
    runtime.invalidate();
    // Drain startup before mounting children, as the previous pane lifecycle did.
    publish();
    setReady(true);
  });
  onCleanup(() => {
    disposed = true;
    runtime.dispose();
    complete?.();
    complete = undefined;
    runtime.updateComplete = Promise.resolve(true);
  });

  return {
    runtime,
    ready,
    revision,
    prepareRender() {
      const { sessionKey, inputRegion, draft, focusComposer } = runtime;
      const next = { sessionKey, inputRegion, draft, focusComposer };
      const changes = {
        sessionKey: next.sessionKey !== previousInputs?.sessionKey,
        inputRegion: next.inputRegion !== previousInputs?.inputRegion,
        draft: next.draft !== previousInputs?.draft,
        focusComposer: next.focusComposer !== previousInputs?.focusComposer,
      };
      previousInputs = next;
      focusPending ||= changes.focusComposer;
      runtime.chatState.prepareRender();
      runtime.synchronizeInputs(changes);
    },
    commitRender() {
      const finish = complete;
      complete = undefined;
      runtime.updateComplete = Promise.resolve(true);
      const focus = focusPending;
      focusPending = false;
      runtime.afterRender(focus);
      runtime.chatState.commitRender();
      finish?.();
    },
  };
}

export type ChatPaneOwner = ReturnType<typeof createChatPane>;
