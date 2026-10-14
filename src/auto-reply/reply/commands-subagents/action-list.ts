// Lists subagent runs with lifecycle status.
import {
  buildSubagentList,
  readSubagentListSessionEntries,
} from "../../../agents/subagents/registry/subagent-list.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { type SubagentsCommandContext, RECENT_WINDOW_MINUTES } from "./shared.js";

export async function handleSubagentsListAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, readContext } = ctx;
  const list = buildSubagentList({
    context: readContext.list,
    sessionEntries: await readSubagentListSessionEntries(params.cfg, readContext.list),
    taskMaxChars: 110,
  });
  const formatRows = (rows: typeof list.active) =>
    rows.length ? rows.map((entry) => entry.line).join("\n") : "(none)";
  return commandReply(
    [
      "active subagents:",
      "-----",
      formatRows(list.active),
      "",
      `recent subagents (last ${RECENT_WINDOW_MINUTES}m):`,
      "-----",
      formatRows(list.recent),
    ].join("\n"),
  );
}
