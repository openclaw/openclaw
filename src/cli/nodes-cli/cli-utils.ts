import { defaultRuntime } from "../../runtime.js";
import { isRich, theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { unauthorizedHintForMessage } from "./rpc.js";

function resolvePairingRequiredHint(message: string): string | null {
  if (!/pairing required/i.test(message)) {
    return null;
  }
  return "Pairing required. Run `openclaw devices list` to inspect pending pairing requests.";
}

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

export function runNodesCommand(label: string, action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    const { error, warn } = getNodesTheme();
    defaultRuntime.error(error(`nodes ${label} failed: ${message}`));
    const pairingHint = resolvePairingRequiredHint(message);
    if (pairingHint) {
      defaultRuntime.error(warn(pairingHint));
    }
    const hint = unauthorizedHintForMessage(message);
    if (hint) {
      defaultRuntime.error(warn(hint));
    }
    defaultRuntime.exit(1);
  });
}
