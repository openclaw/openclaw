/**
 * A single Talk event should feed both trusted diagnostics and structured logs;
 * this facade keeps relay call sites from choosing only one path.
 */
import { recordTalkDiagnosticEvent } from "./diagnostics.js";
import { recordTalkLogEvent } from "./logging.js";
import type { TalkEvent } from "./talk-events.js";

export function recordTalkObservabilityEvent(event: TalkEvent): void {
  recordTalkDiagnosticEvent(event);
  recordTalkLogEvent(event);
}
