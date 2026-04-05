import type { CommandHandlerResult } from "../commands-types.js";
import { buildSubagentsHelp, stopWithText } from "../commands-subagents-read.js";

export function handleSubagentsHelpAction(): CommandHandlerResult {
  return stopWithText(buildSubagentsHelp());
}
