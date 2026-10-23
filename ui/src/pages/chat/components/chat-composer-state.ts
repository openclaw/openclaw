import { createSignal, createStore } from "solid-js";
import type { ChatGoalDraftMode, HumanMention } from "../../../lib/chat/chat-types.ts";
import {
  adjustTextareaHeight,
  disconnectComposerPopoverAnchorObserver,
} from "./chat-composer-dom.ts";
import { createComposerEmojiMenu } from "./chat-composer-emoji.tsx";
import { createHumanMentionMenu } from "./chat-composer-mention-menu.tsx";
import { createSkillMenu } from "./chat-composer-skill-menu.tsx";
import { createSlashMenu } from "./chat-composer-slash-menu.tsx";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

function createChatComposerState(): ChatComposerState {
  const [presentation, updatePresentation] = createStore<ChatComposerState["presentation"]>({
    dictationError: null,
    goalExpandedId: null,
  });
  return {
    // Admission survives composer remounts while the same goal mode is pending.
    goalPending: createSignal<ChatGoalDraftMode | null>(null),
    presentation,
    updatePresentation,
    slashMenu: createSlashMenu(),
    skillMenu: createSkillMenu(),
    slashCommandDispatchConnected: false,
    composerComposing: false,
    editRevision: 0,
    mentionMenu: createHumanMentionMenu(),
    emojiMenu: createComposerEmojiMenu(),
    composerInputIntentKey: null,
    pendingClearedSubmittedDraft: null,
    questionTakeoverActive: false,
    restoreComposerFocus: false,
    composerInput: null,
    composerTextarea: null,
    microphonePicker: null,
    textareaRef: null,
    composerInputRef: null,
    dictation: null,
    composerDraftScope: null,
    dictationSelection: null,
  };
}

const composerStates = new Map<string, ChatComposerState>();

export function getChatComposerState(paneId: string): ChatComposerState {
  let state = composerStates.get(paneId);
  if (!state) {
    state = createChatComposerState();
    composerStates.set(paneId, state);
  }
  return state;
}

export function composerDraftKey(
  props: Pick<ChatComposerProps, "currentAgentId" | "sessionKey">,
): string {
  return `${props.currentAgentId}\u0000${props.sessionKey}`;
}

export function commitComposerDraft(
  props: ChatComposerProps,
  value: string,
  mentions?: readonly HumanMention[],
): void {
  const currentDraft = props.getDraft ? props.getDraft() : props.draft;
  if (currentDraft === value && mentions === undefined) {
    return;
  }
  getChatComposerState(props.paneId).editRevision += 1;
  props.onDraftChange(value, mentions);
}

export function markComposerInputIntent(state: ChatComposerState, key: string): void {
  state.editRevision += 1;
  state.composerInputIntentKey = key;
}

export function consumeComposerInputIntent(state: ChatComposerState, key: string): boolean {
  if (state.composerInputIntentKey !== key) {
    return false;
  }
  state.composerInputIntentKey = null;
  return true;
}

export function clearPendingClearedSubmittedDraft(state: ChatComposerState, key: string): void {
  if (state.pendingClearedSubmittedDraft?.key === key) {
    state.pendingClearedSubmittedDraft = null;
  }
}

export function suppressStaleSubmittedDraftReplay(
  target: HTMLTextAreaElement,
  event: InputEvent,
  currentDraft: string,
  hasInputIntent: boolean,
  state: ChatComposerState,
): boolean {
  const pending = state.pendingClearedSubmittedDraft;
  if (
    !pending ||
    target.value !== pending.value ||
    hasInputIntent ||
    event.inputType === "insertFromPaste" ||
    event.inputType === "insertFromDrop"
  ) {
    return false;
  }

  target.value = currentDraft;
  adjustTextareaHeight(target);
  return true;
}

function disposeChatComposerState(state: ChatComposerState) {
  state.slashMenu.dispose();
  state.skillMenu.dispose();
  state.emojiMenu.dispose();
  state.mentionMenu.dispose();
  state.composerDraftScope = null;
  state.dictation?.dispose();
  state.microphonePicker?.dispose();
  if (state.composerInput) {
    disconnectComposerPopoverAnchorObserver(state.composerInput);
  }
}

export function resetChatComposerState(paneId?: string) {
  for (const state of paneId ? [composerStates.get(paneId)] : composerStates.values()) {
    if (state) {
      disposeChatComposerState(state);
    }
  }
  if (paneId) {
    composerStates.delete(paneId);
  } else {
    composerStates.clear();
  }
}
