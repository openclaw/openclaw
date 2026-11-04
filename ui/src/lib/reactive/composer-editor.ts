import { readHumanMentions } from "../chat/human-mentions.ts";
import { createIdleImport } from "../idle-import.ts";
import { useOptionalApplication } from "./context.ts";
import { elementRef } from "./element-ref.ts";
import { listen } from "./listener.ts";

/** One foreign-DOM owner shared by Chat and New Session. Load CM only when a
 * selected person needs inline layout; retain it until this draft unmounts. */
export function createComposerEditorBinding() {
  const application = useOptionalApplication();
  let input: HTMLTextAreaElement | undefined;
  let composing = false;
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
      editor = mountEditor(input, mentions, application);
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
    const stopStart = listen(node, "compositionstart", () => {
      composing = true;
    });
    const stopEnd = listen(node, "compositionend", () => {
      composing = false;
      requestAnimationFrame(activate);
    });
    if (mentions().length) {
      void loader.load().catch(() => undefined);
    }
    return () => {
      input = undefined;
      observer.disconnect();
      stopStart();
      stopEnd();
      editor?.destroy();
      editor = undefined;
      loader.dispose();
    };
  });
}
