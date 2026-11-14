import type { SessionTreeEntry } from "@openclaw/agent-core";
import { projectModelContextMessages } from "../../shared/model-context-message.js";

/** Memory and deep native rows share the model-only payload projection. */
export function projectSessionModelContextEntry(
  original: SessionTreeEntry,
  {
    entry,
    omitCheckpoint,
    toolResultOmission,
  }: { entry: SessionTreeEntry; omitCheckpoint: boolean; toolResultOmission?: string },
): SessionTreeEntry {
  const event = {
    ...original,
    parentId: entry.parentId,
    ...(entry.type === "compaction" || entry.type === "reset"
      ? { firstKeptEntryId: entry.firstKeptEntryId }
      : {}),
  };
  if (event.type !== "message") {
    return event;
  }
  const [message] = projectModelContextMessages([event.message]);
  const projected = { ...event, message: message! };
  if (omitCheckpoint && projected.message.role === "assistant") {
    projected.message = { ...projected.message };
    delete projected.message.providerReplay;
  }
  if (toolResultOmission !== undefined && projected.message.role === "toolResult") {
    projected.message = {
      ...projected.message,
      content: [{ type: "text", text: toolResultOmission }],
    };
  }
  return projected;
}
