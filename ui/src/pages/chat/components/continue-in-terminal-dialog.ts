import { solidContent } from "../../../lit/solid-content.tsx";
import {
  ContinueInTerminalDialog,
  type ContinueInTerminalDialogProps,
} from "./continue-in-terminal-dialog.tsx";

export function renderContinueInTerminalDialog(props: ContinueInTerminalDialogProps) {
  return solidContent(ContinueInTerminalDialog, props);
}
