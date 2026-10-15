import { solidContent } from "../lit/solid-content.tsx";
import { ConnectCommand } from "./solid/connect-command.tsx";

export function renderConnectCommand(command: string, variant: "inline" | "hero" = "inline") {
  return solidContent(ConnectCommand, { command, variant });
}
