import { warnSessionPersistenceDeprecation } from "../../agents/sessions/session-persistence-deprecation.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";

export function warnMentionInboxDeprecation(
  method: "list" | "dismiss" | "recordCommittedInput" | "invalidate",
): void {
  const pluginId = pluginInstanceInvocation.getStore()?.instance.pluginId;
  warnSessionPersistenceDeprecation(
    `mentionInbox.${method}`,
    `mentionInbox.${method}Async`,
    pluginId === undefined ? undefined : { pluginId },
  );
}
