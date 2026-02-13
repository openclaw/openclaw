import { Command } from "commander";
import { registerBridgeCommand } from "../commands/bridge.js";

export function registerBridgeCli(program: Command) {
  registerBridgeCommand(program);
}
