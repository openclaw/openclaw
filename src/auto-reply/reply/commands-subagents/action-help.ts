import type { CommandHandlerResult } from "../commands-types.js";
import { buildSubagentsHelp, stopWithText } from "./shared.js";

export function handleSubagentsHelpAction(): CommandHandlerResult {
  return stopWithText(buildSubagentsHelp());
}
