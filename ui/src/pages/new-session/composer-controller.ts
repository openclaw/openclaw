import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HumanMentionInput } from "../../lib/chat/human-mentions.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  scheduleTextareaHeightAdjustment,
} from "../chat/components/chat-composer-dom.ts";
import { createComposerEmojiMenu } from "../chat/components/chat-composer-emoji.tsx";
import { createHumanMentionMenu } from "../chat/components/chat-composer-mention-menu.tsx";
import type { ChatComposerPlusMenuView } from "../chat/components/chat-composer-plus-menu.types.ts";
import { createSkillMenu } from "../chat/components/chat-composer-skill-menu.tsx";
import { createSlashMenu } from "../chat/components/chat-composer-slash-menu.tsx";
import { insertComposerDictation } from "../chat/composer-dictation.ts";

export type NewSessionComposerTextarea = ReturnType<typeof createNewSessionComposerTextarea>;

/** Caret and menu mutations stay synchronous for dictation and keyboard handlers. */
export function createNewSessionComposerTextarea() {
  let textarea: HTMLTextAreaElement | null = null;
  let capturedSelection: { start: number; end: number; value: string } | null = null;
  let skillCommandClient: GatewayBrowserClient | null = null;
  let skillCommandAgentId = "";
  let skillCommandDraftOwnerKey = "";
  const control = {
    // An opening gets one cast; typing and async picker updates never reroll it.
    critterVisit: Math.random(),
    skillMenu: createSkillMenu(),
    slashMenu: createSlashMenu(),
    mentionMenu: createHumanMentionMenu(),
    emojiMenu: createComposerEmojiMenu(),
    composing: false,
    // SAFETY: Beforeinput fills this optional selection snapshot.
    mentionInput: undefined as HumanMentionInput | undefined,
    capabilityMenuOpen: false,
    // SAFETY: The closed menu starts at its root; navigation keeps this union.
    capabilityMenuView: "root" as ChatComposerPlusMenuView,
    ref(element?: Element) {
      const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
      if (textarea && textarea !== nextTextarea) {
        disconnectTextareaOverflowObserver(textarea);
      }
      textarea = nextTextarea;
      if (nextTextarea) {
        observeTextareaOverflow(nextTextarea);
        scheduleTextareaHeightAdjustment(nextTextarea);
      }
    },
    syncDraft(message: string) {
      // Programmatic restores need a measurement after the controlled value commits.
      if (textarea?.isConnected && textarea.value !== message) {
        scheduleTextareaHeightAdjustment(textarea);
      }
    },
    /** Keep the pre-preview draft so partial dictation does not compound insertions. */
    captureSelection() {
      capturedSelection = textarea
        ? { start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value }
        : null;
    },
    previewTranscript(transcript: string): string | undefined {
      if (!textarea) {
        return undefined;
      }
      const selection = capturedSelection ?? {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        value: textarea.value,
      };
      return insertComposerDictation(selection.value, transcript, selection.start, selection.end)
        .value;
    },
    /** Commit live keystrokes before the page-owned draft rerenders. */
    insertTranscript(transcript: string, late?: true): string | null {
      const target = textarea;
      if (!target) {
        return null;
      }
      // Delayed finals must not replace edits made after Stop unlocked this draft.
      const selection =
        capturedSelection && (!late || capturedSelection.value === target.value)
          ? capturedSelection
          : {
              start: late ? target.selectionStart : target.value.length,
              end: late ? target.selectionEnd : target.value.length,
              value: target.value,
            };
      capturedSelection = null;
      const insertion = insertComposerDictation(
        selection.value,
        transcript,
        selection.start,
        selection.end,
      );
      if (insertion.value === selection.value) {
        return null;
      }
      target.value = insertion.value;
      adjustTextareaHeight(target);
      queueMicrotask(() => {
        if (target.isConnected) {
          target.focus({ preventScroll: true });
          target.selectionStart = insertion.caret;
          target.selectionEnd = insertion.caret;
        }
      });
      return insertion.value;
    },
    getTextarea: () => textarea,
    syncSkillCommandOwner(
      client: GatewayBrowserClient | null,
      agentId: string,
      draftOwnerKey: string,
    ) {
      const normalizedAgentId = agentId.trim();
      if (control.ownsSkillCommands(client, normalizedAgentId, draftOwnerKey)) {
        return;
      }
      // Route, agent, or Gateway replacement retires prior async menu results.
      skillCommandClient = client;
      skillCommandAgentId = normalizedAgentId;
      skillCommandDraftOwnerKey = draftOwnerKey;
      control.emojiMenu.close();
      control.skillMenu.reset();
      control.slashMenu.reset();
    },
    ownsSkillCommands(
      client: GatewayBrowserClient | null,
      agentId: string,
      draftOwnerKey: string,
    ): boolean {
      return (
        skillCommandClient === client &&
        skillCommandAgentId === agentId.trim() &&
        skillCommandDraftOwnerKey === draftOwnerKey
      );
    },
    disconnect() {
      control.skillMenu.dispose();
      control.slashMenu.dispose();
      control.emojiMenu.dispose();
      control.composing = false;
      control.mentionMenu.dispose();
      skillCommandClient = null;
      skillCommandAgentId = "";
      skillCommandDraftOwnerKey = "";
      control.capabilityMenuOpen = false;
      control.capabilityMenuView = "root";
      control.ref();
    },
  };
  return control;
}
