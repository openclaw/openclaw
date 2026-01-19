import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { unauthorizedHintForMessage } from "./rpc.js";

export function runNodesCommand(label: string, action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    defaultRuntime.error(`nodes ${label} failed: ${message}`);
    const hint = unauthorizedHintForMessage(message);
    if (hint) defaultRuntime.error(hint);
    defaultRuntime.exit(1);
  });
}
