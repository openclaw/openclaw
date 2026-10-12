import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ToolErrorSummary } from "./tool-error-summary.js";

type ToolTerminalState = {
  lastToolError?: ToolErrorSummary;
};

/** Track the run's last tool failure until the same tool succeeds. */
export function createToolErrorState() {
  let lastToolError: ToolErrorSummary | undefined;
  const terminalState = (): ToolTerminalState => (lastToolError ? { lastToolError } : {});

  return {
    read: terminalState,
    recordFailure(failure: ToolErrorSummary) {
      lastToolError = failure;
      return terminalState();
    },
    recordSuccess(toolName: string) {
      if (
        lastToolError &&
        normalizeLowercaseStringOrEmpty(lastToolError.toolName) ===
          normalizeLowercaseStringOrEmpty(toolName)
      ) {
        lastToolError = undefined;
      }
      return terminalState();
    },
  };
}
