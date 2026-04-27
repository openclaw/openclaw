import { buildSubagentsHelp, stopWithText } from "./shared.js";
export function handleSubagentsHelpAction() {
    return stopWithText(buildSubagentsHelp());
}
