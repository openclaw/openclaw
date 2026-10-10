import { flush } from "@solidjs/signals";
import { render, type JSX } from "@solidjs/web";

/** Mount one Solid owner; callers dispose it before removing their fixture. */
export function mountSolid(
  content: () => JSX.Element,
  container: HTMLElement = document.createElement("div"),
) {
  const dispose = render(content, container);
  flush();
  return { container, dispose };
}
