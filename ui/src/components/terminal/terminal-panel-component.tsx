import { createEffect, onSettled, untrack } from "solid-js";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { TerminalPanelHostedActions, TerminalPanelView } from "./terminal-panel-view.tsx";
import type { TerminalPanelOwner } from "./terminal-panel.ts";

export function TerminalPanel(props: { owner: TerminalPanelOwner }) {
  const application = useOptionalApplication();
  // Native ownerFor(host) retains this owner for the lifetime of this mount.
  const owner = untrack(() => props.owner);
  owner.bindPresentation();
  const state = projectOwner(owner, (current) => current.viewState);
  // Ghostty and hosted tab consumers need committed DOM before measuring.
  createEffect(state.read, () => owner.rendered());
  onSettled(() => {
    let disposed = false;
    let detach: (() => void) | undefined;
    const connect = () => {
      if (!disposed && owner.inputs.isConnected) {
        detach = owner.attach(application);
      }
    };
    // Direct Solid hosts settle before their parent inserts them.
    if (owner.inputs.isConnected) {
      connect();
    } else {
      queueMicrotask(connect);
    }
    return () => {
      disposed = true;
      detach?.();
    };
  });
  // The side-panel header moves this Solid-owned node outside the panel's host.
  <TerminalPanelHostedActions
    view={state.read}
    ref={(element) => {
      owner.hostedActionsContent = element;
    }}
  />;
  return <TerminalPanelView view={state.read} />;
}
