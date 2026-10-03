import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { PluginRuntime } from "./types.js";

export const subscribeRuntimeSessionChanges: PluginRuntime["gateway"]["subscribeSessionChanges"] = (
  listener,
) =>
  sessionChanges.subscribeFacts((change) => {
    if (!("sessionKey" in change)) {
      return;
    }
    const agentId = change.agentId ?? parseAgentSessionKey(change.sessionKey)?.agentId;
    if (!agentId) {
      return;
    }
    listener({
      agentId,
      sessionKey: change.sessionKey,
      ...(change.factsInvalidated === undefined
        ? {}
        : { factsInvalidated: String(change.factsInvalidated) }),
    });
  });
