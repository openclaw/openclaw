/** Runtime facade for compact command dependencies. */
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { withSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";

export async function prepareCurrentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  expected: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
}): Promise<{ entry: SessionEntry; assertCurrent: () => void; release: () => void } | undefined> {
  const matchesExpected = (entry: SessionEntry | undefined) =>
    entry?.sessionId === params.expected.sessionId &&
    entry.lifecycleRevision === params.expected.lifecycleRevision;
  if (isIncognitoSessionKey(params.sessionKey)) {
    const entry = loadSessionEntryReadOnly(params);
    if (!entry || !matchesExpected(entry)) {
      return undefined;
    }
    return {
      entry,
      assertCurrent() {
        const current = loadSessionEntryReadOnly(params);
        if (!matchesExpected(current) || current?.activeWriterRunId !== entry.activeWriterRunId) {
          throw new Error("command session changed");
        }
      },
      release() {},
    };
  }
  return withSessionEntriesFromStoreInWorker(
    {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKeys: [params.sessionKey],
    },
    async ({ result }) => {
      const entry = result.entries.find((row) => row.sessionKey === params.sessionKey)?.entry;
      const identity = result.databaseIdentity?.identity;
      if (!entry || !identity || !matchesExpected(entry)) {
        return undefined;
      }
      const retained = retainPreparedSessionEntryPredicate({
        databaseIdentity: `file:${identity}`,
        sessionKey: params.sessionKey,
        entry,
        matches: (before, after) =>
          after?.sessionId === before?.sessionId &&
          after?.lifecycleRevision === before?.lifecycleRevision &&
          after?.activeWriterRunId === before?.activeWriterRunId,
      });
      return {
        entry,
        assertCurrent() {
          if (!retained.isCurrent()) {
            throw new Error("command session changed");
          }
        },
        release: retained.release,
      };
    },
  );
}

export {
  abortEmbeddedAgentRun,
  compactEmbeddedAgentSession,
  isEmbeddedAgentRunAbortableForCompaction,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent.js";
export { resolveFreshSessionTotalTokens } from "../../config/sessions.js";
export { enqueueSystemEvent } from "../../infra/system-events.js";
export { formatContextUsageShort, formatTokenCount } from "../status.js";
export { incrementCompactionCount } from "./session-updates.js";
