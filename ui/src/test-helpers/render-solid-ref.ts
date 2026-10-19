import { onSettled } from "solid-js";
import { mountSolid, type MountSolidOptions } from "./mount-solid.ts";

type Ref<E extends HTMLElement> = (element: E) => void;

// beta.3's renderRef ignores container, wrapper, queries, and hydrate. Keep
// their forwarding in mountSolid, and evaluate ref factories under its owner.
export function renderSolidRef<E extends HTMLElement = HTMLDivElement>(
  createRef: () => Ref<E> | Ref<E>[],
  options: MountSolidOptions & { targetElement: E | (() => E) },
) {
  return mountSolid(() => {
    const element =
      typeof options.targetElement === "function" ? options.targetElement() : options.targetElement;
    const refs = createRef();
    onSettled(() => {
      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        ref(element);
      }
    });
    return element;
  }, options);
}
