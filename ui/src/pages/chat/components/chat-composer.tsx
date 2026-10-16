import { createEffect, createMemo, createSignal, merge, onCleanup, untrack } from "solid-js";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { createChatComposerContext } from "./chat-composer-frame.ts";
import { ComposerPredictionController } from "./chat-composer-prediction.ts";
import { composerDraftKey, getChatComposerState, isChatRunWorking } from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { renderChatComposerView } from "./chat-composer-view.tsx";

export { isChatRunWorking, resetChatComposerState } from "./chat-composer-state.ts";

export function ChatComposer(props: ChatComposerProps) {
  const state = getChatComposerState(untrack(() => props.paneId));
  // A replacement draft retires the native input's uncommitted IME preview.
  const [composition, setComposition] = createSignal<{ key: string; value: string } | null>(() => {
    composerDraftKey(props);
    return null;
  });
  const [error, setError] = createSignal<string | null>(null);
  const interaction = { composition, setComposition, error, setError };
  const [revision, setRevision] = createSignal(0);
  let computingFrame = false;
  let deferredInvalidation = false;
  let disposed = false;
  const requestUpdate = () => {
    if (disposed) {
      return;
    }
    if (computingFrame) {
      if (!deferredInvalidation) {
        deferredInvalidation = true;
        queueMicrotask(() => {
          deferredInvalidation = false;
          requestUpdate();
        });
      }
      return;
    }
    setRevision((value) => value + 1);
  };
  const draft = createMemo(() => {
    const source = props.draftSource;
    return source ? projectOwner(source, (owner) => owner.read()) : undefined;
  });
  const draftState = createMemo(() => draft()?.read());
  const currentProps = merge(props, () => draftState() ?? {}, { onRequestUpdate: requestUpdate });
  const prediction = new ComposerPredictionController(() => {
    const options = currentProps.composerPredictions;
    const client = currentProps.gatewayClient;
    if (!options || !client) {
      return null;
    }
    return {
      gateway: options.gateway,
      client,
      sessionKey: currentProps.sessionKey,
      sessionId: currentProps.currentSessionId ?? null,
      enabled: options.enabled,
      eligible:
        options.active &&
        currentProps.connected &&
        currentProps.canSend &&
        !currentProps.submitDisabledReason &&
        !currentProps.suggestionComposer &&
        !currentProps.realtimeTalkActive &&
        !state.composerComposing &&
        !state.dictation?.active &&
        !currentProps.goalDraftMode &&
        !currentProps.replyTarget &&
        !(currentProps.getDraft?.() ?? currentProps.draft) &&
        !state.composerTextarea?.value &&
        !(currentProps.getAttachments?.() ?? currentProps.attachments)?.length &&
        !(currentProps.getPendingAttachmentReads?.() ?? currentProps.pendingAttachmentReads) &&
        document.visibilityState !== "hidden",
      idle: !isChatRunWorking(currentProps) && !currentProps.sending && !currentProps.queue.length,
    };
  }, requestUpdate);
  const context = createMemo(() => {
    draftState();
    revision();
    computingFrame = true;
    try {
      return createChatComposerContext(currentProps, interaction, prediction);
    } finally {
      computingFrame = false;
    }
  });
  createEffect(
    () => {
      context();
      return currentProps.composerPredictions;
    },
    () => untrack(() => prediction.sync()),
  );
  const visibilityChanged = () => prediction.sync();
  document.addEventListener("visibilitychange", visibilityChanged);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", visibilityChanged);
    prediction.dispose();
    disposed = true;
    state.textareaRef?.();
    state.composerInputRef?.();
  });
  return renderChatComposerView(context, currentProps);
}
