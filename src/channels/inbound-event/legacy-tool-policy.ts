import type { GroupToolPolicyConfig } from "../../config/types.tools.js";

let warned = false;

/** Compatibility applies only to the original external request, including its queue wait. */
export function resolveLegacyConversationToolPolicy<T extends GroupToolPolicyConfig>(
  policy: T | undefined,
): T | undefined {
  if (policy && !warned) {
    warned = true;
    process.emitWarning(
      "Channel access.toolPolicy / MsgContext.ConversationToolPolicy is deprecated. " +
        "Resolve configured permissions through security.resolveDirectToolPolicy or groups.resolveToolPolicy. " +
        "The legacy snapshot applies only to the original request, including its queued turn; " +
        "it does not refresh at admission or propagate into new delegations. " +
        "Removal requires an announced deprecation window and explicit maintainer approval " +
        "for a later stable release; no removal date is set.",
      { type: "DeprecationWarning", code: "DEP_CHANNEL_PREPARED_TOOL_POLICY" },
    );
  }
  return policy;
}
