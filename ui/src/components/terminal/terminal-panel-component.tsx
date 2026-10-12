import "../dock-panel-solid.css";
import "../panel-tab-strip-solid.css";
import "./terminal-panel.css";
import { createMemo, untrack } from "solid-js";
import { usePanelController } from "../solid-panel-controller.ts";
import { TerminalPanelView } from "./terminal-panel-view.tsx";
import type { TerminalPanelController } from "./terminal-panel.ts";

export function TerminalPanel(props: { controller: TerminalPanelController }) {
  // A bridge mount owns one controller until its host disconnects.
  const controller = untrack(() => props.controller);
  usePanelController(controller);
  const view = createMemo(() => controller.read().viewState);
  return <TerminalPanelView view={view} />;
}
