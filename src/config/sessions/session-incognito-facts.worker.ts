import { resolveIncognitoSessionExpiresAt } from "../../shared/incognito-session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseIncognitoIdentity } from "../../state/openclaw-agent-execution-identity.types.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { projectSessionEntryCapabilityFacts } from "./session-entry-capability-facts.js";
import type { IncognitoSessionSnapshot } from "./session-incognito-contract.js";
import type { IncognitoSessionFacts } from "./session-incognito-facts.types.js";
import { projectIncognitoSessionReadRevisions } from "./session-incognito-read-revisions.js";
import { projectIncognitoSessionRuntimeFacts } from "./session-incognito-runtime-facts.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";

export function createIncognitoSessionSnapshotReader(
  database: OpenClawAgentDatabase,
  identity: AgentDatabaseIncognitoIdentity,
  facts: {
    revision(sessionKey: string): number;
    completionSources(sessionKey: string): IncognitoSessionFacts["completionSources"];
  },
) {
  return (sessionKey: string): IncognitoSessionSnapshot => {
    const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
    return {
      entry,
      facts: [
        {
          identity,
          sessionKey,
          revision: facts.revision(sessionKey),
          completionSources: facts.completionSources(sessionKey),
          capability: entry ? projectSessionEntryCapabilityFacts(entry) : undefined,
          ...projectIncognitoSessionReadRevisions(entry),
          ...projectIncognitoSessionRuntimeFacts(entry),
          cliHistory:
            entry?.cliHistoryBoundary?.state === "known"
              ? {
                  boundary: entry.cliHistoryBoundary,
                  watermark: readSessionTranscriptWatermarkInDatabase(database, entry.sessionId),
                }
              : undefined,
          sharing: entry
            ? {
                entry: projectSessionSharingEntry(entry),
                membership: new Set(
                  listSessionMembersInDatabase(database, sessionKey).map(
                    (member) => member.identityId,
                  ),
                ),
              }
            : undefined,
          expiresAt: entry ? resolveIncognitoSessionExpiresAt(entry) : undefined,
        },
      ],
    };
  };
}

export function withIncognitoSessionFacts<Value>(
  value: Value,
  facts: IncognitoSessionFacts[],
): Value extends unknown ? { value: Value; facts: IncognitoSessionFacts[] } : never;
export function withIncognitoSessionFacts(value: unknown, facts: IncognitoSessionFacts[]) {
  return { value, facts };
}
