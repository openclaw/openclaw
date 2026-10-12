import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { hasSessionTranscriptMessageInDatabase } from "./session-accessor.sqlite-transcript-metadata-read.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import { captureIncognitoSessionHistoryBinding } from "./session-incognito-binding.js";
import {
  readIncognitoSessionHistory,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

/** Read the cold marker and both message probes in the history worker's one snapshot. */
export function hasSessionTranscriptMessage(
  scope: SessionTranscriptReadScope,
  suppliedIncognito?: IncognitoSessionHistoryBinding,
): Promise<boolean> {
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    return readIncognitoSessionHistory(incognito, scope, (target) => ({
      type: "session.history.message-presence",
      input: target,
    }));
  }
  return withSessionTranscriptReadSource(
    scope,
    (captured) => {
      const resolved = resolveSqliteTranscriptReadScope(captured);
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      return hasSessionTranscriptMessageInDatabase(database, resolved.sessionId);
    },
    ({ scope: captured, resolved, owner, expectedIdentity, assertCurrent }) =>
      readRestoredSessionTranscript(
        captured,
        () => owner.readMessagePresence({ scope: captured, expectedIdentity }),
        {
          assertCurrent,
          coldRead: {
            target: resolved,
            readMetadata: async () => {
              const metadata = await owner.readColdMetadata({
                sessionId: resolved.sessionId,
                env: captured.env ?? {},
              });
              assertCurrent();
              return metadata.archive;
            },
          },
        },
      ),
  );
}
