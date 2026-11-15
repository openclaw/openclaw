import { warnSessionPersistenceDeprecation } from "../../agents/sessions/session-persistence-deprecation.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";

/** Share the per-method warning budget across legacy transcript adapters. */
export function warnSessionTranscriptPreparationDeprecation(
  method: string,
  replacement: string,
): void {
  const pluginId = pluginInstanceInvocation.getStore()?.instance.pluginId;
  warnSessionPersistenceDeprecation(method, replacement, {
    pluginId,
    family: "session-transcript",
  });
}
