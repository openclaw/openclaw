import { renderCodexAppServerFailureCopy } from "../agents/failover/user-copy.js";
import { resolveSessionStartupErrorPresentation } from "../shared/session-startup-error-presentation.js";
import { formatForLog } from "./ws-log.js";

export function renderChatRunError(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  const diagnostic = formatForLog(error);
  return (
    resolveSessionStartupErrorPresentation(diagnostic)?.display ??
    renderCodexAppServerFailureCopy(diagnostic) ??
    diagnostic
  );
}
