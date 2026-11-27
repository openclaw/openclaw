import {
  focusComposerInput,
  readComposerEditor,
  withExactComposerInsertion,
} from "../../lib/composer-input.ts";
import type { ChatComposerProps, ChatComposerState } from "./components/chat-composer-types.ts";
import type { DeveloperDictationTarget } from "./composer-developer-syntax.ts";
import { normalizeChatComposerDraft } from "./composer-draft.ts";

export function captureDeveloperDictationTarget(
  props: ChatComposerProps,
  state: ChatComposerState,
): DeveloperDictationTarget | undefined {
  const input = state.composerTextarea;
  const client = props.gatewayClient;
  if (!input?.isConnected || !client || !props.connected || !(props.canCompose ?? props.canSend)) {
    return undefined;
  }
  const draft = props.getDraft?.() ?? props.draft;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const revision = state.editRevision;
  const publicationRevision = props.draftSource?.read().draftPublicationRevision;
  const scope = state.composerDraftScope;
  const sessionKey = props.sessionKey;
  const sessionId = props.currentSessionId;
  const editor = readComposerEditor(input);
  const isCurrent = (expectedRevision = revision) =>
    state.composerTextarea === input &&
    input.isConnected &&
    !input.disabled &&
    !state.composerComposing &&
    props.gatewayClient === client &&
    props.connected &&
    (props.canCompose ?? props.canSend) &&
    props.pluginActionsPresented !== false &&
    props.realtimeTalkActive !== true &&
    props.sessionKey === sessionKey &&
    props.currentSessionId === sessionId &&
    state.composerDraftScope === scope &&
    state.editRevision === expectedRevision &&
    props.draftSource?.read().draftPublicationRevision === publicationRevision &&
    (props.getDraft?.() ?? props.draft) === draft &&
    input.value === draft &&
    input.selectionStart === start &&
    input.selectionEnd === end &&
    readComposerEditor(input) === editor;
  // Qualify against the editor and the existing blur/persistence owner. Copy
  // retains CR/CRLF and whitespace-only results those owners cannot retain.
  const canInsertExact = (text: string) => {
    const next = draft.slice(0, start) + text + draft.slice(end);
    return (
      (editor !== undefined || typeof input.ownerDocument.execCommand === "function") &&
      !text.includes("\r") &&
      normalizeChatComposerDraft(next) === next
    );
  };
  return {
    isCurrent: () => isCurrent(),
    canInsertExact,
    insert(text, isAuthorized = () => true) {
      if (!isCurrent() || input.readOnly || !canInsertExact(text) || !isAuthorized()) {
        return false;
      }
      if (editor) {
        // The editor owns mention range mapping and its native history transaction.
        withExactComposerInsertion(input, () => editor.replace(text, start, end));
        focusComposerInput(input, { preventScroll: true });
        return true;
      }
      // Like emoji insertion, the browser editing command owns native undo and
      // publishes input through the existing draft owner. Direct value writes do not.
      focusComposerInput(input, { preventScroll: true });
      if (!isCurrent() || input.readOnly || !isAuthorized()) {
        return false;
      }
      // Native no-op insertion emits no input to consume a beforeinput intent.
      if (!text && start === end) {
        return true;
      }
      const before = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertReplacementText",
        data: text,
      });
      // The mounted input owner records this one beforeinput intent. A callback
      // may also replace the draft, selection, or authority: check after dispatch.
      if (
        !input.dispatchEvent(before) ||
        !isCurrent(revision + 1) ||
        input.readOnly ||
        !isAuthorized()
      ) {
        return false;
      }
      return withExactComposerInsertion(
        input,
        () => input.ownerDocument.execCommand?.("insertText", false, text) ?? false,
      );
    },
  };
}
