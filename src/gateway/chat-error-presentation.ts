import { renderCodexAppServerFailureCopy } from "../agents/failover/user-copy.js";
import { formatForLog } from "./ws-log.js";

export function renderChatRunError(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  const diagnostic = formatForLog(error);
  return renderCodexAppServerFailureCopy(diagnostic) ?? diagnostic;
}
