import { warnSessionPersistenceDeprecation } from "../../agents/sessions/session-persistence-deprecation.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";

export function warnMentionInboxDeprecation(
  method: "list" | "dismiss" | "recordCommittedInput" | "invalidate",
): void {
  const pluginId = pluginInstanceInvocation.getStore()?.instance.pluginId;
  warnSessionPersistenceDeprecation(`mentionInbox.${method}`, `mentionInbox.${method}Async`, {
    pluginId,
    family: "mention-inbox",
    compatibility:
      "Legacy recording queues work after commit; await recordCommittedInputAsync for completion. Other synchronous methods retain their completion timing.",
  });
}
