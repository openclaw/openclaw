import { warnSessionPersistenceDeprecation } from "../../agents/sessions/session-persistence-deprecation.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";

export function warnMentionInboxDeprecation(method: "validateRecipients"): void {
  const pluginId = pluginInstanceInvocation.getStore()?.instance.pluginId;
  warnSessionPersistenceDeprecation(`mentionInbox.${method}`, `mentionInbox.${method}Async`, {
    pluginId,
    family: "mention-inbox",
    compatibility:
      "Await validateRecipientsAsync to prepare recipient authority through the existing worker. The synchronous validation contract remains available during its deprecation period.",
  });
}
