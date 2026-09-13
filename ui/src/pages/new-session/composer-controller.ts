import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HumanMentionInput } from "../../lib/chat/human-mentions.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  scheduleTextareaHeightAdjustment,
} from "../chat/components/chat-composer-dom.ts";
import { ComposerEmojiMenu } from "../chat/components/chat-composer-emoji.ts";
import { HumanMentionMenu } from "../chat/components/chat-composer-mention-menu.ts";
import type { ChatComposerPlusMenuView } from "../chat/components/chat-composer-plus-menu.ts";
import {
  createSkillMenuState,
  resetSkillMenuState,
} from "../chat/components/chat-composer-skill-menu.ts";
import {
  createSlashMenuState,
  resetSlashMenuState,
} from "../chat/components/chat-composer-slash-menu.ts";
import { insertComposerDictation } from "../chat/composer-dictation.ts";

export class NewSessionComposerTextareaController {
  private textarea: HTMLTextAreaElement | null = null;
  private placeholderFrame: number | null = null;
  private placeholderStartedAt: number | null = null;
  private placeholderText = "";
  private placeholderTarget = "";
  private placeholderEntered = false;
  private capturedSelection: { start: number; end: number; value: string } | null = null;
  private skillCommandClient: GatewayBrowserClient | null = null;
  private skillCommandAgentId = "";
  private skillCommandDraftOwnerKey = "";
  readonly skillMenuState = createSkillMenuState();
  readonly slashMenuState = createSlashMenuState();
  readonly mentionMenu = new HumanMentionMenu();
  readonly emojiMenu = new ComposerEmojiMenu();
  composing = false;
  mentionInput?: HumanMentionInput;
  capabilityMenuOpen = false;
  capabilityMenuView: ChatComposerPlusMenuView = "root";

  readonly ref = (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    if (this.textarea && this.textarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(this.textarea);
    }
    if (this.textarea && !nextTextarea) {
      this.resetPlaceholder();
    }
    this.textarea = nextTextarea;
    if (nextTextarea) {
      observeTextareaOverflow(nextTextarea);
      scheduleTextareaHeightAdjustment(nextTextarea);
    }
  };

  syncDraft(message: string) {
    // The stable ref measures attachment only. Programmatic restores and
    // resets still need a post-render measurement after Lit commits .value.
    if (this.textarea?.isConnected && this.textarea.value !== message) {
      scheduleTextareaHeightAdjustment(this.textarea);
    }
  }

  getPlaceholder(target: string, message: string, requestUpdate: () => void) {
    if (message.length > 0 || this.placeholderEntered) {
      this.placeholderEntered = true;
      if (this.placeholderFrame !== null) {
        globalThis.cancelAnimationFrame?.(this.placeholderFrame);
        this.placeholderFrame = null;
      }
      return target;
    }
    if (this.placeholderTarget !== target) {
      this.resetPlaceholder();
      this.placeholderTarget = target;
    }
    const requestFrame = globalThis.requestAnimationFrame?.bind(globalThis);
    if (
      !requestFrame ||
      (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
    ) {
      this.placeholderText = target;
      this.placeholderEntered = true;
      return target;
    }
    if (this.placeholderFrame === null) {
      const step = (timestamp: number) => {
        this.placeholderStartedAt ??= timestamp;
        const elapsed = Math.max(0, timestamp - this.placeholderStartedAt - 180);
        const length = Math.min(target.length, Math.floor(elapsed / 26));
        if (length !== this.placeholderText.length) {
          this.placeholderText = target.slice(0, length);
          requestUpdate();
        }
        if (length < target.length) {
          this.placeholderFrame = requestFrame(step);
          return;
        }
        this.placeholderFrame = null;
        this.placeholderEntered = true;
      };
      this.placeholderFrame = requestFrame(step);
    }
    return this.placeholderText;
  }

  private resetPlaceholder() {
    if (this.placeholderFrame !== null) {
      globalThis.cancelAnimationFrame?.(this.placeholderFrame);
      this.placeholderFrame = null;
    }
    this.placeholderStartedAt = null;
    this.placeholderText = "";
    this.placeholderTarget = "";
    this.placeholderEntered = false;
  }

  /**
   * Remembers the live draft and caret before another control takes focus.
   * Partial previews rewrite the textarea, so commit must keep using this base
   * snapshot or each successive transcript would be inserted into the last preview.
   */
  captureSelection() {
    const target = this.textarea;
    this.capturedSelection = target
      ? { start: target.selectionStart, end: target.selectionEnd, value: target.value }
      : null;
  }

  previewTranscript(transcript: string): string | undefined {
    const target = this.textarea;
    if (!target) {
      return undefined;
    }
    const selection = this.capturedSelection ?? {
      start: target.selectionStart,
      end: target.selectionEnd,
      value: target.value,
    };
    return insertComposerDictation(selection.value, transcript, selection.start, selection.end)
      .value;
  }

  /**
   * Writes a transcript into the draft at the remembered caret and returns the
   * new draft, or null when there is nothing to insert.
   *
   * The captured element value includes keystrokes not yet committed upward.
   * Writing the final insertion directly grows the box before the next render
   * commits that same value into the page-owned draft.
   */
  insertTranscript(transcript: string, late?: true): string | null {
    const target = this.textarea;
    if (!target) {
      return null;
    }
    const captured = this.capturedSelection;
    // Delayed finals must not replace edits made after Stop unlocked this draft.
    const selection =
      captured && (!late || captured.value === target.value)
        ? captured
        : {
            start: late ? target.selectionStart : target.value.length,
            end: late ? target.selectionEnd : target.value.length,
            value: target.value,
          };
    this.capturedSelection = null;
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
      if (!target.isConnected) {
        return;
      }
      target.focus({ preventScroll: true });
      target.selectionStart = insertion.caret;
      target.selectionEnd = insertion.caret;
    });
    return insertion.value;
  }

  readonly getTextarea = () => this.textarea;

  syncSkillCommandOwner(
    client: GatewayBrowserClient | null,
    agentId: string,
    draftOwnerKey: string,
  ) {
    const normalizedAgentId = agentId.trim();
    if (
      this.skillCommandClient === client &&
      this.skillCommandAgentId === normalizedAgentId &&
      this.skillCommandDraftOwnerKey === draftOwnerKey
    ) {
      return;
    }
    // The controller survives route, agent, and Gateway changes. Invalidate its
    // menu generation so a prior owner cannot publish into the next draft.
    this.skillCommandClient = client;
    this.skillCommandAgentId = normalizedAgentId;
    this.skillCommandDraftOwnerKey = draftOwnerKey;
    this.emojiMenu.close();
    resetSkillMenuState(this.skillMenuState);
  }

  ownsSkillCommands(client: GatewayBrowserClient, agentId: string, draftOwnerKey: string): boolean {
    return (
      this.skillCommandClient === client &&
      this.skillCommandAgentId === agentId.trim() &&
      this.skillCommandDraftOwnerKey === draftOwnerKey
    );
  }

  disconnect() {
    this.emojiMenu.close();
    this.composing = false;
    this.mentionMenu.dispose();
    this.resetPlaceholder();
    this.skillCommandClient = null;
    this.skillCommandAgentId = "";
    this.skillCommandDraftOwnerKey = "";
    resetSkillMenuState(this.skillMenuState);
    resetSlashMenuState(this.slashMenuState);
    this.capabilityMenuOpen = false;
    this.capabilityMenuView = "root";
    if (this.textarea) {
      disconnectTextareaOverflowObserver(this.textarea);
      this.textarea = null;
    }
  }
}
