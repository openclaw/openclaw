import { warnSessionPersistenceDeprecation } from "../../agents/sessions/session-persistence-deprecation.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";

/** One warning budget for the legacy transcript transaction contract per plugin. */
export function warnSessionTranscriptPreparationDeprecation(): void {
  const pluginId = pluginInstanceInvocation.getStore()?.instance.pluginId;
  warnSessionPersistenceDeprecation(
    "Transcript transaction callbacks and withSessionTranscriptWriteLock",
    "withSessionTranscriptWrite with preparation.prepareMessage / preparation.source",
    pluginId === undefined ? undefined : { pluginId },
  );
}
