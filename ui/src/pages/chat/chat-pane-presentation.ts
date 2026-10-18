import { createEffect, createMemo, createSignal } from "solid-js";
import { PRESENTATION_CHANGED_EVENT, type PresentationValue } from "../../lib/presentation.ts";
import { listen } from "../../lib/reactive/listener.ts";

/** Park immediately; reveal alongside the parent's next props unless explicitly previewing. */
export function usePanePresentation(source: () => PresentationValue) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  // The presentation owner emits DOM events independently of parent props.
  createEffect(source, (binding) => {
    if (typeof binding === "boolean") {
      return undefined;
    }
    return listen(binding.owner, PRESENTATION_CHANGED_EVENT, () => {
      if (!binding.isPresented() || binding.preview?.()) {
        setRevision((value) => value + 1);
      }
    });
  });
  return createMemo(() => {
    revision();
    const binding = source();
    return typeof binding === "boolean" ? binding : binding.isPresented();
  });
}
