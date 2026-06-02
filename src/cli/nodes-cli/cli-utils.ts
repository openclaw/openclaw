import { isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { unauthorizedHintForMessage } from "./rpc.js";

/** Build the node command theme once so rich/no-color output stays consistent. */
export function getNodesTheme() {
  const rich = isRich();
  const color = (fn: (value: string) => string) => (value: string) => (rich ? fn(value) : value);
  return {
    rich,
    heading: color(theme.heading),
    ok: color(theme.success),
    warn: color(theme.warn),
    muted: color(theme.muted),
    error: color(theme.error),
  };
}

/** Run a nodes subcommand with shared failure formatting and bridge auth hints. */
export function runNodesCommand(label: string, action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    const { error, warn } = getNodesTheme();
    defaultRuntime.error(error(`nodes ${label} failed: ${message}`));
    const hint = unauthorizedHintForMessage(message);
    if (hint) {
      defaultRuntime.error(warn(hint));
    }
    defaultRuntime.exit(1);
  });
}
