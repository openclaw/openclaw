import { createMemo, createRenderEffect, createSignal } from "solid-js";
import { PRESENTATION_CHANGED_EVENT, type PresentationValue } from "../../lib/presentation.ts";

/** Park immediately; reveal alongside the parent's next props unless explicitly previewing. */
export function usePanePresentation(source: () => PresentationValue) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  createRenderEffect(source, (binding) => {
    if (typeof binding === "boolean") {
      return undefined;
    }
    const changed = () => {
      if (!binding.isPresented() || binding.preview?.()) {
        setRevision((value) => value + 1);
      }
    };
    binding.owner.addEventListener(PRESENTATION_CHANGED_EVENT, changed);
    return () => binding.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, changed);
  });
  return createMemo(() => {
    revision();
    const binding = source();
    return typeof binding === "boolean" ? binding : binding.isPresented();
  });
}
