import type { HumanMention } from "../chat/chat-types.ts";
import { HUMAN_MENTION_CLIPBOARD_TYPE, readHumanMentions } from "../chat/human-mentions.ts";
import { createIdleImport } from "../idle-import.ts";
import { useOptionalApplication } from "./context.ts";
import { elementRef } from "./element-ref.ts";
import { listen } from "./listener.ts";

/** One foreign-DOM owner shared by Chat and New Session. Load CM only when a
 * selected person needs inline layout; retain it until this draft unmounts. */
export function createMentionComposerBinding(
  getMentions: () => readonly HumanMention[],
  avatarUrls?: ReadonlyMap<string, string>,
) {
  const application = useOptionalApplication();
  return elementRef<HTMLTextAreaElement>((node) => {
    const native = new AbortController();
    let composing = false;
    let entryHistory:
      | import("../../pages/chat/components/composer-editor-mentions.tsx").ComposerMentionSnapshot
      | undefined;
    let mountEditor:
      | typeof import("../../pages/chat/components/composer-editor-mentions.tsx").mountMentionComposerEditor
      | undefined;
    let editor: ReturnType<NonNullable<typeof mountEditor>> | undefined;
    const mentions = () => readHumanMentions(node.value, getMentions()) ?? [];
    // A transfer mounts for its own insertion, which the editor's history then owns.
    function activate(forTransfer = false) {
      if (
        !native.signal.aborted &&
        !composing &&
        (forTransfer || mentions().length) &&
        mountEditor
      ) {
        editor = mountEditor(
          node,
          getMentions,
          application,
          forTransfer ? undefined : entryHistory,
          avatarUrls,
        );
        entryHistory = undefined;
        // Retire only after a successful handoff; a failed mount keeps native editing.
        native.abort();
      }
    }
    const loader = createIdleImport(
      () => import("../../pages/chat/components/composer-editor-mentions.tsx"),
      (module) => {
        mountEditor = module.mountMentionComposerEditor;
        activate();
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
        }
      },
      { signal: native.signal },
    );
    listen(
      node,
      "input",
      () => {
        if (!composing) {
          entryHistory = snapshot();
        }
      },
      { signal: native.signal },
    );
    // One observer follows the native port before and after rich-editor activation.
    // Both attributes and feature metadata reconcile through the same owner.
    const observer = new MutationObserver(() => {
      if (editor) {
        editor.sync();
      } else if (!composing && mentions().length) {
        // The load callback fires once; a later mention must still activate.
        void loader.load().then(
          () => activate(),
          () => undefined,
        );
      }
    });
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
    if (mentions().length) {
      void loader.load().then(
        () => activate(),
        () => undefined,
      );
    }
    return () => {
      native.abort();
      observer.disconnect();
      editor?.destroy();
      loader.dispose();
    };
  });
}
