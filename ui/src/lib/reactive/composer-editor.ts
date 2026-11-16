import type { HumanMention } from "../chat/chat-types.ts";
import { HUMAN_MENTION_CLIPBOARD_TYPE, readHumanMentions } from "../chat/human-mentions.ts";
import { registerComposerActivation } from "../composer-input.ts";
import { createIdleImport } from "../idle-import.ts";
import { useOptionalApplication } from "./context.ts";
import { elementRef } from "./element-ref.ts";
import { listen } from "./listener.ts";

/** One foreign-DOM owner shared by Chat and New Session. Load CM only when a
 * person or skill reference needs inline layout; retain it until this draft unmounts. */
export function createReferenceComposerBinding(
  getMentions: () => readonly HumanMention[],
  avatarUrls?: ReadonlyMap<string, string>,
) {
  const application = useOptionalApplication();
  return elementRef<HTMLTextAreaElement>((node) => {
    const native = new AbortController();
    let composing = false;
    let editingSkillValue: string | undefined;
    let nativeEdit: InputEvent | undefined;
    let entryHistory:
      | import("../../pages/chat/components/composer-editor-mentions.tsx").ComposerMentionSnapshot
      | undefined;
    let previousInput: typeof entryHistory;
    let feature:
      | typeof import("../../pages/chat/components/composer-editor-references.ts")
      | undefined;
    let editor: ReturnType<NonNullable<typeof feature>["mountReferenceComposerEditor"]> | undefined;
    const mentions = () => readHumanMentions(node.value, getMentions()) ?? [];
    // A transfer mounts for its own insertion, which the editor's history then owns.
    function activate(forTransfer = false) {
      if (!native.signal.aborted && !composing && feature) {
        editor = feature.mountReferenceComposerEditor(
          node,
          getMentions,
          application,
          entryHistory,
          avatarUrls,
          forTransfer,
          (nativeEdit?.inputType === "insertText" && !nativeEdit.defaultPrevented) ||
            editingSkillValue === node.value
            ? node.selectionStart
            : undefined,
          previousInput,
        );
        if (!editor) {
          return;
        }
        entryHistory = previousInput = undefined;
        nativeEdit = undefined;
        // Retire only after a successful handoff; a failed mount keeps native editing.
        native.abort();
        stopActivation();
      }
    }
    const loader = createIdleImport(
      () => import("../../pages/chat/components/composer-editor-references.ts"),
      (module) => {
        feature = module;
      },
    );
    const snapshot = () => ({
      value: node.value,
      mentions: mentions(),
      selection: {
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      },
    });
    listen(
      node,
      "focus",
      () => {
        if (!composing && !mentions().length) {
          entryHistory = snapshot();
          previousInput = undefined;
        }
      },
      { signal: native.signal },
    );
    listen(
      node,
      "input",
      (event) => {
        if (!composing) {
          editingSkillValue = event.inputType === "insertText" ? node.value : undefined;
          nativeEdit = undefined;
          // Keep both sides until the lazy feature can distinguish a skill
          // insertion from a literal dollar followed by a person query.
          previousInput = entryHistory;
          if (!feature || !feature.readComposerSkillReferences(node.value).length) {
            entryHistory = snapshot();
          }
          requestActivation();
        }
      },
      { signal: native.signal },
    );
    listen(
      node,
      "selectionchange",
      () => {
        if (!composing) {
          requestActivation();
        }
      },
      { signal: native.signal },
    );
    // One observer follows the native port before and after rich-editor activation.
    // Both attributes and feature metadata reconcile through the same owner.
    function requestActivation() {
      if (editor) {
        editor.sync();
      } else if (!composing && (mentions().length || node.value.includes("$"))) {
        // Handoff stays outside the Solid apply phase even after this module
        // loaded for an earlier literal dollar. Mention widgets create roots.
        void loader.load().then(
          () => activate(),
          () => undefined,
        );
      }
    }
    const stopActivation = registerComposerActivation(node, requestActivation);
    const observer = new MutationObserver(requestActivation);
    observer.observe(node, { attributes: true });
    // Recipient transfers have one owner, the rich editor: mount it, then replay the
    // paste or drop there. DataTransfer is readable only during its event.
    type Transfer = { text: string; raw: string };
    const readTransfer = (data: DataTransfer | null): Transfer | undefined => {
      const raw = data && !data.files.length && data.getData(HUMAN_MENTION_CLIPBOARD_TYPE);
      return raw ? { text: data.getData("text/plain"), raw } : undefined;
    };
    async function transfer(event: Event, copied: Transfer | undefined, drop: boolean) {
      if (!copied || composing || event.defaultPrevented || node.disabled || node.readOnly) {
        return;
      }
      event.preventDefault();
      try {
        await loader.load();
        activate(true);
      } catch {
        // Handled below: the transfer still arrives, as plain text.
      }
      if (editor) {
        editor.transfer(copied.text, copied.raw, drop);
      } else if (!native.signal.aborted) {
        // Without the editor nothing can show a recipient, so none is bound.
        node.setRangeText(copied.text, node.selectionStart, node.selectionEnd, "end");
        node.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: drop ? "insertFromDrop" : "insertFromPaste",
            data: null,
          }),
        );
      }
    }
    listen(
      node,
      "paste",
      (event) => void transfer(event, readTransfer(event.clipboardData), false),
      { signal: native.signal },
    );
    let dropped: Transfer | undefined;
    listen(
      node,
      "drop",
      (event) => {
        dropped = readTransfer(event.dataTransfer);
      },
      { signal: native.signal },
    );
    listen(
      node,
      "beforeinput",
      (event) => {
        // Native input listeners can run microtasks between callbacks. An owner
        // echo must already know this is typing before our input callback runs.
        nativeEdit = event;
        const copied = dropped;
        dropped = undefined;
        if (event.inputType === "insertFromDrop") {
          // The browser resolves the drop caret after drop, before beforeinput.
          void transfer(event, copied, true);
        }
      },
      { signal: native.signal },
    );
    listen(
      node,
      "compositionstart",
      () => {
        composing = true;
      },
      { signal: native.signal },
    );
    listen(
      node,
      "compositionend",
      () => {
        composing = false;
        entryHistory = snapshot();
        requestAnimationFrame(() => activate());
      },
      { signal: native.signal },
    );
    requestActivation();
    return () => {
      native.abort();
      stopActivation();
      observer.disconnect();
      editor?.destroy();
      loader.dispose();
    };
  });
}
