import type { JSX } from "@solidjs/web";
import { createContext, createEffect, onCleanup, untrack, useContext } from "solid-js";
import { ShellLayoutOwner, type ShellLayoutTraits } from "./shell-layout-owner.ts";

/** The scope anchors page reporters to the shell content owner. */
export const ShellLayoutProvider = createContext<{ owner: ShellLayoutOwner; host: Element } | null>(
  null,
);

export function ShellLayoutBoundary(props: { traits: ShellLayoutTraits; children: JSX.Element }) {
  const scope = useContext(ShellLayoutProvider);
  if (scope) {
    const token = {};
    // Descendants can measure during setup; later changes commit before their effects.
    const initialTraits = untrack(() => props.traits);
    scope.owner.record(token, scope.host, initialTraits);
    createEffect(
      () => props.traits,
      (traits) => scope.owner.record(token, scope.host, traits),
    );
    onCleanup(() => scope.owner.clear(token));
  }
  return <>{props.children}</>;
}
