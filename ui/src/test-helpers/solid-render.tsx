import type { JSX } from "@solidjs/web";
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach } from "vitest";

const disposals = new Set<() => void>();

afterEach(() => {
  for (const dispose of disposals) {
    dispose();
  }
  disposals.clear();
});

export function mountSolid<Props extends object>(
  Component: (props: Props) => JSX.Element,
  initial: Props,
  container: HTMLElement = document.createElement("div"),
) {
  const [props, setProps] = createSignal(initial, { equals: false });
  const unmount = render(() => <Component {...props()} />, container);
  const dispose = () => {
    unmount();
    disposals.delete(dispose);
  };
  disposals.add(dispose);
  flush();
  return {
    container,
    update(next: Props) {
      setProps(() => next);
      flush();
    },
    dispose,
  };
}
