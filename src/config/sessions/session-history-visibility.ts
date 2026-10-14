import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../agents/internal-runtime-context.js";

export function isVisibleHistoryNonMessageEvent(event: Record<string, unknown>): boolean {
  return (
    event.type === "reset" ||
    event.type === "compaction" ||
    (event.type === "custom_message" &&
      event.display === true &&
      event.customType !== OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE)
  );
}
