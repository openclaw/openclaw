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
    let entryHistory:
      | import("../../pages/chat/components/composer-editor-mentions.tsx").ComposerMentionSnapshot
      | undefined;
    let previousInput: typeof entryHistory;
    const loader = createIdleImport(
      () => import("../../pages/chat/components/composer-editor-references.ts"),
    );
    let editor:
      | ReturnType<
          typeof import("../../pages/chat/components/composer-editor-references.ts").mountReferenceComposerEditor
        >
      | undefined;
    let skillProbe:
      | ReturnType<typeof import("../chat/skill-references.ts").createNativeSkillProbe>
      | undefined;
    const skillsLoader = createIdleImport(
      () => import("../chat/skill-references.ts"),
      (module) => {
        skillProbe = module.createNativeSkillProbe(node, requestActivation, native.signal);
        requestActivation();
      },
    );
    const mentions = () => readHumanMentions(node.value, getMentions()) ?? [];
    // Both admissions and recipient transfers share the one deferred handoff.
    async function activate(forTransfer = false) {
      try {
        const feature = await loader.load();
        if (!native.signal.aborted && !composing) {
          editor = feature.mountReferenceComposerEditor(
            node,
            getMentions,
            application,
            entryHistory,
            avatarUrls,
            forTransfer,
            editingSkillValue,
            previousInput,
          );
          if (editor) {
            entryHistory = previousInput = undefined;
            editingSkillValue = undefined;
            native.abort();
            skillsLoader.dispose();
            skillProbe?.dispose();
            skillProbe = undefined;
          }
        }
      } catch {
        // Optional decoration failed to load; keep the usable native draft.
      }
    }
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
          skillProbe?.input(event);
          // Capture the applied edit before controlled-input listeners reconcile it.
          editingSkillValue = event.inputType === "insertText" ? node.value : undefined;
          // Keep both sides until the lazy feature can distinguish a skill
          // insertion from a literal dollar followed by a person query.
          previousInput = entryHistory;
          if (!skillProbe?.hasReferences()) {
            entryHistory = snapshot();
          }
          requestActivation();
        }
      },
      { capture: true, signal: native.signal },
    );
    // One observer follows the native port; the parser watches its own caret and catalog.
    function requestActivation() {
      if (editor) {
        editor.sync();
      } else if (!composing) {
        if (mentions().length || skillProbe?.hasReferences(editingSkillValue)) {
          void activate();
        } else if (!skillProbe && node.value.includes("$")) {
          void skillsLoader.load().catch(() => undefined);
        }
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
      await activate(true);
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
        skillProbe?.beforeInput(event);
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
        requestAnimationFrame(() => {
          if (!native.signal.aborted) {
            requestActivation();
          }
        });
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
      skillsLoader.dispose();
      skillProbe?.dispose();
    };
  });
}
