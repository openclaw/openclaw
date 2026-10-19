import {
  createEffect,
  createMemo,
  createProjection,
  createSignal,
  merge,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import { listen } from "../../../lib/reactive/listener.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { ComposerDictationOwner } from "../composer-dictation.ts";
import { ComposerMicrophoneOwner } from "../composer-microphone-picker.ts";
import {
  createChatComposerContext,
  createComposerDictationOptions,
} from "./chat-composer-frame.ts";
import { createGoalComposer } from "./chat-composer-goal-mode.tsx";
import { createComposerPrediction } from "./chat-composer-prediction.ts";
import { createComposerQuestionPanel } from "./chat-composer-question.tsx";
import { composerDraftKey, getChatComposerState, isChatRunWorking } from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { renderChatComposerView } from "./chat-composer-view.tsx";

export { isChatRunWorking, resetChatComposerState } from "./chat-composer-state.ts";

export function ChatComposer(props: ChatComposerProps) {
  // A pane owns this component's lifetime; a different pane mounts a different composer.
  const initialPaneId = untrack(() => props.paneId);
  const state = getChatComposerState(initialPaneId);
  // Unrelated prop updates must preserve the native input's uncommitted IME preview.
  const compositionDraftKey = createMemo(() => composerDraftKey(props));
  const [composition, setComposition] = createSignal<{ key: string; value: string } | null>(() => {
    compositionDraftKey();
    return null;
  });
  const interaction = {
    composition,
    setComposition,
    error: () => state.presentation.dictationError,
    setError: (error: string | null) => {
      state.updatePresentation((draft) => {
        draft.dictationError = error;
      });
    },
  };
  const draft = createMemo(() => {
    const source = props.draftSource;
    return source ? projectOwner(source, (owner) => owner.read()) : undefined;
  });
  const draftState = createMemo(() => draft()?.read());
  // Draft edits must not recreate unrelated footer and notice content.
  const currentProps = merge(
    props,
    createProjection(() => draftState() ?? {}, {}, { shallow: true }),
  );
  const goalComposer = createGoalComposer(() => currentProps, state);
  const microphonePicker = (state.microphonePicker ??= new ComposerMicrophoneOwner());
  if (!state.dictation) {
    // Seed this retained owner once; later configuration is admitted by update(), not recreation.
    const initialDictationOptions = untrack(() =>
      createComposerDictationOptions(currentProps, state, microphonePicker, interaction.setError),
    );
    state.dictation = new ComposerDictationOwner(initialDictationOptions);
  }
  const voice = { dictation: state.dictation, picker: microphonePicker };
  // Dictation admission invalidates edits and dismisses errors before the next input event.
  onCleanup(
    voice.dictation.subscribe(() => {
      if (voice.dictation.locksComposer) {
        state.editRevision += 1;
        currentProps.onDismissRealtimeTalkError?.();
      }
    }),
  );
  const dictation = projectOwner(voice.dictation, (owner) => owner);
  const microphone = projectOwner(voice.picker, (owner) => owner);
  const prediction = createComposerPrediction(() => {
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
  });
  const questionPanel = createComposerQuestionPanel(() => currentProps, state, composition);
  const context = createMemo(() => {
    draftState();
    dictation.read();
    microphone.read();
    return createChatComposerContext(
      currentProps,
      interaction,
      goalComposer,
      voice,
      prediction,
      questionPanel(),
    );
  });
  createEffect(
    () => ({ context: context(), predictions: currentProps.composerPredictions }),
    ({ context: current }, previous) => {
      state.mentionMenu.syncDirectory(current.mentionDirectory);
      if (current.clearSlashMenu) {
        state.slashMenu.reset();
      }
      if (current.clearSkillMenu) {
        state.skillMenu.reset();
      }
      if (!current.emojiEnabled || current.draftKey !== previous?.context.draftKey) {
        state.emojiMenu.close();
      }
      const options = current.dictationOptions;
      voice.picker.syncCatalog(options.client, options.connected, options.sessionKey);
      voice.dictation.update(options);
      prediction.sync();
    },
  );
  onSettled(() => listen(document, "visibilitychange", () => prediction.sync()));
  return renderChatComposerView(context, currentProps, state);
}
