import { createMemo } from "solid-js";
import { PRESENTATION_CHANGED_EVENT, type PresentationValue } from "../../lib/presentation.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectSource } from "../../lib/reactive/projection.ts";

/** Park immediately; reveal alongside the parent's next props unless explicitly previewing. */
export function usePanePresentation(source: () => PresentationValue) {
  const presentation = createMemo(() => {
    const binding = source();
    if (typeof binding === "boolean") {
      return binding;
    }
    return projectSource(binding, {
      read: (owner) => owner.isPresented(),
      subscribe: (owner, notify) =>
        listen(owner.owner, PRESENTATION_CHANGED_EVENT, () => {
          if (!owner.isPresented() || owner.preview?.()) {
            notify();
          }
        }),
      equality: "revision",
    });
  });
  return createMemo(() => {
    const current = presentation();
    return typeof current === "boolean" ? current : current.read();
  });
}
