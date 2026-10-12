import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readTranscriptStatsSync } from "./session-accessor.sqlite-read.js";
import {
  captureIncognitoSessionHistoryBinding,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import { readIncognitoSessionHistory } from "./session-incognito-history-read.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

/** Read hot and cold statistics through the captured history owner's read-only worker. */
export function readTranscriptStatsAsync(scope: SessionTranscriptReadScope) {
  const incognitoSource = captureIncognitoSessionSource(scope);
  if (incognitoSource && "kind" in incognitoSource) {
    incognitoSource.assertCurrent();
    return Promise.resolve({ eventCount: 0, maxSeq: 0, sizeBytes: 0 });
  }
  const incognito = captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    return readIncognitoSessionHistory(incognito, scope, (target) => ({
      type: "session.history.stats",
      input: target,
    }));
  }
  return withSessionTranscriptReadSource(
    scope,
    readTranscriptStatsSync,
    ({ scope: captured, resolved, owner, expectedIdentity }) =>
      owner.readStats({ scope: { ...captured, sessionId: resolved.sessionId }, expectedIdentity }),
  );
}
