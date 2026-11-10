import { Portal, type JSX } from "@solidjs/web";
import { Show, useContext } from "solid-js";
import { ShellLayoutProvider } from "../../app/shell-layout-traits-solid.tsx";

/**
 * Page buttons for the phone header's pill, ahead of new session and search.
 * Pass it through a page header's `actions`; `fallback` renders in place at every
 * other layout, so the page declares one set of actions.
 */
export function FloatingHeaderActions(props: { children: JSX.Element; fallback?: JSX.Element }) {
  const scope = useContext(ShellLayoutProvider);
  return (
    <Show when={scope?.owner.headerActionsSlot()} fallback={props.fallback}>
      {(slot) => <Portal mount={slot()}>{props.children}</Portal>}
    </Show>
  );
}
