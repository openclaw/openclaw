import { render as renderLit, type RenderOptions } from "lit";
import { flush } from "./solid-settle.ts";

/** Legacy fixtures must retire their nested Solid roots before replacing globals. */
export function createLitTestRenderer() {
  const containers = new Set<HTMLElement>();
  return {
    render(this: void, value: unknown, container: HTMLElement, options?: RenderOptions) {
      containers.add(container);
      return renderLit(value, container, options);
    },
    async cleanup(this: void) {
      for (const container of containers) {
        renderLit(null, container);
        container.remove();
      }
      containers.clear();
      // SolidContent and custom-element disconnection dispose in a microtask.
      await Promise.resolve();
      flush();
    },
  };
}
