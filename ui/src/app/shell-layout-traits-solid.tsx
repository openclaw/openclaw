import type { JSX } from "@solidjs/web";
import { createContext, createRenderEffect, onCleanup, untrack, useContext } from "solid-js";
import { ShellLayoutOwner, type ShellLayoutTraits } from "./shell-layout-owner.ts";

/** The host is the connected route mount, not its still-detached rendered children. */
export const ShellLayoutProvider = createContext<{ owner: ShellLayoutOwner; host: Element } | null>(
  null,
);

export function ShellLayoutBoundary(props: { traits: ShellLayoutTraits; children: JSX.Element }) {
  const scope = useContext(ShellLayoutProvider);
  if (scope) {
    const token = {};
    // Publish before evaluating child getters; the render effect owns later changes.
    scope.owner.record(
      token,
      scope.host,
      untrack(() => props.traits),
    );
    createRenderEffect(
      () => props.traits,
      (traits) => scope.owner.record(token, scope.host, traits),
    );
    onCleanup(() => scope.owner.clear(token));
  }
  return <>{props.children}</>;
}
