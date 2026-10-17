import "../dock-panel-solid.css";
import "./terminal-panel.css";
import { createMemo, untrack } from "solid-js";
import { usePanelController } from "../solid-panel-controller.ts";
import { TerminalPanelHostedActions, TerminalPanelView } from "./terminal-panel-view.tsx";
import type { TerminalPanelController } from "./terminal-panel.ts";

export function TerminalPanel(props: { controller: TerminalPanelController }) {
  // A bridge mount owns one controller until its host disconnects.
  const controller = untrack(() => props.controller);
  controller.bindPresentation();
  usePanelController(controller);
  const view = createMemo(() => controller.read().viewState);
  // The side-panel header moves this Solid-owned node outside the panel's host.
  <TerminalPanelHostedActions
    view={view}
    ref={(element) => {
      controller.hostedActionsContent = element;
    }}
  />;
  return <TerminalPanelView view={view} />;
}
