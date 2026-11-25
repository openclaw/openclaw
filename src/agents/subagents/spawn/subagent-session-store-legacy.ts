import {
  loadExactSessionEntryReadOnly,
  loadSessionEntryByIdReadOnly,
} from "../../../config/sessions/session-accessor.js";
import {
  withLegacySessionCapabilityReader,
  type SessionCapabilityRead,
} from "./subagent-session-store.js";

/** Explicit compatibility scope for deprecated synchronous plugin SDK factories. */
export function withLegacySessionCapabilityRead<T>(read: () => T): T {
  return withLegacySessionCapabilityReader((query: SessionCapabilityRead) => {
    const scope = {
      storePath: query.storePath,
      agentId: query.agentId,
      projection: "list" as const,
    };
    try {
      return query.sessionKey !== undefined
        ? loadExactSessionEntryReadOnly({ ...scope, sessionKey: query.sessionKey })?.entry
        : loadSessionEntryByIdReadOnly({ ...scope, sessionId: query.sessionId })?.entry;
    } catch {
      // Preserve the deprecated API's missing or unavailable store behavior.
      return undefined;
    }
  }, read);
}
