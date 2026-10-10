import {
  getQueriesForElement,
  type render as testingLibraryRender,
} from "@solidjs/testing-library";
import { hydrate, render, type JSX } from "@solidjs/web";
import { createComponent } from "solid-js";
import { afterEach } from "vitest";
import { cleanupSolid, trackSolidRoot } from "./solid-cleanup.ts";

export { cleanupSolid } from "./solid-cleanup.ts";

// Testing Library advertises location but does not implement router integration.
export type MountSolidOptions = Omit<
  NonNullable<Parameters<typeof testingLibraryRender>[1]>,
  "location"
>;

afterEach(cleanupSolid);

export function mountSolid(ui: () => JSX.Element, options: MountSolidOptions = {}) {
  const baseElement = options.baseElement ?? options.container ?? document.body;
  const container = options.container ?? baseElement.appendChild(document.createElement("div"));
  const ownedContainer = options.container === undefined;
  const wrapper = options.wrapper;
  const wrapped = wrapper
    ? () =>
        createComponent(wrapper, {
          get children() {
            return createComponent(ui, {});
          },
        })
    : ui;
  let dispose: (() => void) | undefined;
  try {
    dispose = (options.hydrate ? hydrate : render)(wrapped, container);
    const queries = getQueriesForElement(container, options.queries);
    const unmount = trackSolidRoot(() => {
      try {
        dispose?.();
      } finally {
        container.replaceChildren();
        if (ownedContainer) {
          container.remove();
        }
      }
    });
    return { ...queries, container, baseElement, unmount };
  } catch (error) {
    try {
      dispose?.();
    } finally {
      container.replaceChildren();
      if (ownedContainer) {
        container.remove();
      }
    }
    throw error;
  }
}
