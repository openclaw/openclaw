import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ControlledSubagentRunsReadContext } from "../../../agents/subagents/registry/subagent-control-scope.js";
import type { SubagentRunRecord } from "../../../agents/subagents/registry/subagent-registry.types.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandler, CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";

export const RECENT_WINDOW_MINUTES = 30;

type SubagentsCommandParams = Parameters<CommandHandler>[0];

export type SubagentsCommandContext = {
  params: SubagentsCommandParams;
  requesterKey: string;
  readContext: Pick<ControlledSubagentRunsReadContext, "list">;
  restTokens: string[];
};

export function resolveSubagentEntryForToken(
  view: ControlledSubagentRunsReadContext["list"]["view"],
  token: string | undefined,
): { entry: SubagentRunRecord } | { reply: CommandHandlerResult } {
  const fail = (message: string) => ({ reply: commandReply(`⚠️ ${message}`) });
  const trimmed = normalizeOptionalString(token);
  if (!trimmed) {
    return fail("Missing subagent id.");
  }
  const { latest, active, recent } = view;
  if (trimmed === "last") {
    const entry = latest[0];
    return entry ? { entry } : fail("Unknown subagent.");
  }
  const numericOrder = [...active, ...recent];
  if (/^\d+$/.test(trimmed)) {
    const entry = numericOrder[Number.parseInt(trimmed, 10) - 1];
    return entry ? { entry } : fail(`Invalid subagent index: ${trimmed}`);
  }
  if (trimmed.includes(":")) {
    const entry = latest.find((run) => run.childSessionKey === trimmed);
    return entry ? { entry } : fail(`Unknown subagent session: ${trimmed}`);
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const match = (entries: SubagentRunRecord[], ambiguity: string) => {
    if (entries.length > 1) {
      return fail(`${ambiguity}: ${trimmed}`);
    }
    const entry = entries[0];
    return entry ? { entry } : undefined;
  };
  const matchLabel = (prefix: boolean) => {
    const matches = (value: string | undefined) => {
      const label = normalizeLowercaseStringOrEmpty(value);
      return prefix ? label.startsWith(lowered) : label === lowered;
    };
    const ambiguity = `Ambiguous subagent label${prefix ? " prefix" : ""}`;
    return (
      match(
        numericOrder.filter((entry) => matches(entry.taskName)),
        ambiguity,
      ) ??
      match(
        latest.filter((entry) => matches(formatRunLabel(entry))),
        ambiguity,
      )
    );
  };
  return (
    matchLabel(false) ??
    matchLabel(true) ??
    match(
      latest.filter((entry) => entry.runId.startsWith(trimmed)),
      "Ambiguous run id prefix",
    ) ??
    fail(`Unknown subagent id: ${trimmed}`)
  );
}

export function buildSubagentsHelp() {
  return [
    "Subagents",
    "Usage:",
    "- /subagents list",
    "- /subagents log <id|#> [limit] [tools]",
    "- /subagents info <id|#>",
    "- /session unbind",
    "- /agents",
    "- /session idle <duration|off>",
    "- /session max-age <duration|off>",
    "",
    "Ids: use the list index (#), runId/session prefix, label, or full session key.",
  ].join("\n");
}
