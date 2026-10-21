import { createMemo, onSettled } from "solid-js";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { createPointerDrag } from "../../../lib/reactive/pointer-drag.ts";
import { ComposerLayout, type ComposerLayoutOptions } from "./chat-composer-layout.ts";

/** Bind the shared geometry owner after Solid commits the surface and its children. */
export function createComposerLayoutRef(
  options: () => ComposerLayoutOptions,
  active: () => boolean = () => true,
) {
  const layout = new ComposerLayout(createPointerDrag());
  let input: HTMLElement | undefined;
  let shell: HTMLElement | undefined;
  const binding = createMemo(() => ({ value: options(), active: active() }));
  createLayoutMeasurement(
    binding,
    () => {
      const next = binding();
      if (next.active && input) {
        layout.update(input, next.value);
      } else {
        layout.disconnect();
      }
    },
    {
      targets: () => [shell, ...layout.targets()].filter((node): node is Element => Boolean(node)),
      mutations: () => shell!,
    },
  );
  onSettled(() => () => layout.disconnect());
  return Object.assign(
    (element: HTMLElement) => {
      input = element;
    },
    {
      shell: (element: HTMLElement) => {
        shell = element;
      },
    },
  );
}
