import { render, type JSX } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach } from "vitest";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

export function mountUsageView(view: () => JSX.Element, container: HTMLElement): void {
  disposers.push(render(view, container));
  flush();
}
