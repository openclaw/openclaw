import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { mountSolid as mount } from "./mount-solid.ts";

export function mountSolid<Props extends object>(
  Component: (props: Props) => JSX.Element,
  initial: Props,
  container: HTMLElement = document.createElement("div"),
) {
  const [props, setProps] = createSignal<Props>(() => initial, { equals: false });
  const view = mount(() => <Component {...props()} />, { container });
  flush();
  return {
    container,
    update(next: Props) {
      setProps(() => next);
      flush();
    },
    dispose: view.unmount,
  };
}
