import {
  prepareHumanMentionPaste,
  readHumanMentionClipboard,
} from "../chat/human-mention-clipboard.ts";
import { readHumanMentions, withHumanMentionEdit } from "../chat/human-mentions.ts";
import { createIdleImport } from "../idle-import.ts";
import { useOptionalApplication } from "./context.ts";
import { elementRef } from "./element-ref.ts";
import { listen } from "./listener.ts";

/** One foreign-DOM owner shared by Chat and New Session. Load CM only when a
 * selected person needs inline layout; retain it until this draft unmounts. */
export function createComposerEditorBinding(avatarUrls?: ReadonlyMap<string, string>) {
  const application = useOptionalApplication();
  let input: HTMLTextAreaElement | undefined;
  let composing = false;
  let entryHistory:
    | import("../../pages/chat/components/composer-editor-view.tsx").ComposerEditorSnapshot
    | undefined;
  let editor: { sync: () => void; destroy: () => void } | undefined;
  let mountEditor:
    | typeof import("../../pages/chat/components/composer-editor-view.tsx").mountComposerEditor
    | undefined;
  function mentions() {
    if (!input) {
      return [];
    }
    try {
      return (
        readHumanMentions(input.value, JSON.parse(input.dataset.composerMentions ?? "[]")) ?? []
      );
    } catch {
      return [];
    }
  }
  function activate() {
    if (input && !editor && !composing && mentions().length && mountEditor) {
      editor = mountEditor(input, mentions, application, entryHistory, avatarUrls);
      entryHistory = undefined;
    }
  }
  const loader = createIdleImport(
    () => import("../../pages/chat/components/composer-editor-view.tsx"),
    (module) => {
      mountEditor = module.mountComposerEditor;
      activate();
    },
  );
  return elementRef<HTMLTextAreaElement>((node) => {
    input = node;
    let pasting = false;
    const snapshot = () => ({
      value: node.value,
      mentions: mentions(),
      selection: {
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      },
    });
    const stopFocus = listen(node, "focus", () => {
      if (!editor && !composing && !mentions().length) {
        entryHistory = snapshot();
      }
    });
    const stopInput = listen(node, "input", () => {
      if (!editor && !composing && !pasting) {
        entryHistory = snapshot();
      }
    });
    // Solid owns the selected-range attribute; this foreign-DOM owner consumes
    // its committed changes without adding a second reactive state/effect.
    const observer = new MutationObserver(() => {
      if (editor) {
        editor.sync();
      } else if (!composing && mentions().length) {
        void loader.load().catch(() => undefined);
      }
    });
    observer.observe(node, { attributes: true, attributeFilter: ["data-composer-mentions"] });
    // Keep clipboard behavior consistent before the first chip loads CM.
    const stopPaste = listen(node, "paste", (event) => {
      if (editor || composing || event.defaultPrevented || node.disabled || node.readOnly) {
        return;
      }
      const copied = readHumanMentionClipboard(event.clipboardData);
      if (!copied) {
        return;
      }
      const value = node.value;
      const start = node.selectionStart;
      const end = node.selectionEnd;
      const paste = prepareHumanMentionPaste(value, start, end, copied);
      entryHistory = snapshot();
      event.preventDefault();
      node.setRangeText(paste.text, start, end, "end");
      const restored = paste.mentions.map((mention) => ({
        profileId: mention.profileId,
        start: mention.start + start,
        end: mention.end + start,
      }));
      pasting = true;
      try {
        withHumanMentionEdit(
          node.value,
          { mode: "merge", mentions: restored },
          { value, start, end, inputType: "insertFromPaste" },
          () => {
            node.dispatchEvent(
              new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: null }),
            );
          },
        );
      } finally {
        pasting = false;
      }
    });
    const stopStart = listen(node, "compositionstart", () => {
      composing = true;
    });
    const stopEnd = listen(node, "compositionend", () => {
      composing = false;
      if (!editor) {
        entryHistory = snapshot();
      }
      requestAnimationFrame(activate);
    });
    if (mentions().length) {
      void loader.load().catch(() => undefined);
    }
    return () => {
      input = undefined;
      entryHistory = undefined;
      observer.disconnect();
      stopFocus();
      stopInput();
      stopPaste();
      stopStart();
      stopEnd();
      editor?.destroy();
      editor = undefined;
      loader.dispose();
    };
  });
}
