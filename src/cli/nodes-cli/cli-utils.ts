import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import type { NodesRpcOpts } from "./types.js";

/** Return color helpers that degrade to plain text in non-rich terminals. */
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

export function formatConnectionFlagReminder(opts: NodesRpcOpts): string | null {
  const flags = [
    normalizeOptionalString(opts.url) ? "--url" : null,
    normalizeOptionalString(opts.token) ? "--token" : null,
  ].filter((flag) => flag !== null);
  return flags.length > 0
    ? `Reuse the same connection option${flags.length === 1 ? "" : "s"} when rerunning: ${flags.join(", ")}.`
    : null;
}

/** Run a node CLI action with standard failure text and authorization hints. */
export function runNodesCommand(label: string, action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = formatErrorMessage(err);
    const { error, warn } = getNodesTheme();
    defaultRuntime.error(error(`nodes ${label} failed: ${message}`));
    const normalized = normalizeLowercaseStringOrEmpty(message);
    if (
      normalized.includes("unauthorizedclient") ||
      normalized.includes("bridge client is not authorized") ||
      normalized.includes("unsigned bridge clients are not allowed")
    ) {
      defaultRuntime.error(
        warn(
          "peekaboo bridge rejected the client. " +
            "sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with " +
            "PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev.",
        ),
      );
    }
    defaultRuntime.exit(1);
  });
}
