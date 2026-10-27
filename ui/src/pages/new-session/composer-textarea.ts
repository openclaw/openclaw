import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HumanMentionInput } from "../../lib/chat/human-mentions.ts";
import {
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  scheduleTextareaHeightAdjustment,
} from "../chat/components/chat-composer-dom.ts";
import { createComposerEmojiMenu } from "../chat/components/chat-composer-emoji-state.ts";
import { createHumanMentionMenu } from "../chat/components/chat-composer-mention-menu-state.ts";
import { createSkillMenu } from "../chat/components/chat-composer-skill-menu-state.ts";
import { createSlashMenu } from "../chat/components/chat-composer-slash-menu-state.ts";
import type { ChatComposerPlusMenuView } from "../chat/composer-capability-types.ts";
import { createDirectDictationTextarea } from "../chat/composer-direct-dictation.ts";

export type NewSessionComposerTextarea = ReturnType<typeof createNewSessionComposerTextarea>;

/** Caret and menu mutations stay synchronous for dictation and keyboard handlers. */
export function createNewSessionComposerTextarea() {
  let textarea: HTMLTextAreaElement | null = null;
  let skillCommandClient: GatewayBrowserClient | null = null;
  let skillCommandAgentId = "";
  let skillCommandDraftOwnerKey = "";
  const control = {
    ...createDirectDictationTextarea(() => textarea),
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
