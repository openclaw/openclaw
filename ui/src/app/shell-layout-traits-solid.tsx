import type { JSX } from "@solidjs/web";
import { createContext, createEffect, onSettled, useContext } from "solid-js";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { ShellLayoutOwner, type ShellLayoutTraits } from "./shell-layout-owner.ts";

/** The scope anchors page reporters to the shell content owner. */
export const ShellLayoutProvider = createContext<{ owner: ShellLayoutOwner; host: Element } | null>(
  null,
);

export function createFooterControlRef() {
  const scope = useContext(ShellLayoutProvider);
  return elementRef((element: HTMLElement) => scope?.owner.registerFooterControlSurface(element));
}

export function ShellLayoutBoundary(props: { traits: ShellLayoutTraits; children: JSX.Element }) {
  const scope = useContext(ShellLayoutProvider);
  if (scope) {
    const token = {};
    // Publish before descendants' settled setup and measurement effects.
    createEffect(
      () => props.traits,
      (traits) => scope.owner.record(token, scope.host, traits),
    );
    onSettled(() => () => scope.owner.clear(token));
  }
  return <>{props.children}</>;
}
