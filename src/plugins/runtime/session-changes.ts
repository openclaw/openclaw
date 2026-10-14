import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { PluginRuntime } from "./types.js";

export const subscribeRuntimeSessionChanges: PluginRuntime["gateway"]["subscribeSessionChanges"] = (
  listener,
) =>
  // Plugin callbacks may authorize effects, so every private fact must already be installed.
  sessionChanges.subscribeProjection((change) => {
    if (!("sessionKey" in change)) {
      return;
    }
    const agentId = change.agentId ?? parseAgentSessionKey(change.sessionKey)?.agentId;
    if (!agentId) {
      return;
    }
    const factsInvalidated =
      change.factsInvalidated ?? (change.facts?.kind === "category" ? "category" : undefined);
    listener({
      agentId,
      sessionKey: change.sessionKey,
      ...(factsInvalidated === undefined ? {} : { factsInvalidated: String(factsInvalidated) }),
    });
  });
