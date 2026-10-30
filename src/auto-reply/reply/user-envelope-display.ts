import { stripEnvelope } from "../../shared/chat-envelope.js";
import { findCodeRegions, isInsideCode, type CodeRegion } from "../../shared/text/code-ranges.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;
// Stored task envelopes predate the separation of user task and system guidance.
// Match only the generated leading context, never arbitrary bracketed task text.
const SUBAGENT_TASK_PREFIX =
  /^\[Subagent Context\] You are running as a subagent \(depth \d+\/\d+\)\. Complete the current \[Subagent Task\]; inherited conversation is background context, not your assignment\.\n\n(?:\[Subagent Context\] This subagent session is persistent and remains available for thread follow-up messages\.\n\n)?\[Subagent Task\]\n\n/u;
const SUBAGENT_TASK_SUFFIX = "\n\nBegin. Execute the assigned task to completion.";

export function stripUserEnvelopeForDisplay(text: string): string {
  let displayText = stripEnvelope(stripInternalMetadataForDisplay(text));
  if (/\[message_id:/i.test(displayText)) {
    // Match parser offsets against the same LF-normalized lines used for removal.
    // Return the original bytes when no generated hint is removed.
    const normalized = displayText.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    let offset = 0;
    let regions: CodeRegion[] | undefined;
    const filtered = lines.filter((line) => {
      const markerOffset = line.search(/\[message_id:/i);
      const shouldRemove =
        markerOffset >= 0 &&
        MESSAGE_ID_LINE.test(line) &&
        !isInsideCode(offset + markerOffset, (regions ??= findCodeRegions(normalized)));
      offset += line.length + 1;
      return !shouldRemove;
    });
    if (filtered.length !== lines.length) {
      displayText = filtered.join("\n");
    }
  }
  const prefix = displayText.match(SUBAGENT_TASK_PREFIX);
  if (!prefix) {
    return displayText;
  }
  const task = displayText.slice(prefix[0].length);
  return task.endsWith(SUBAGENT_TASK_SUFFIX) ? task.slice(0, -SUBAGENT_TASK_SUFFIX.length) : task;
}
