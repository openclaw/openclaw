import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";

/** A completed named conversation whose transcript survives deletion of its live row. */
export async function seedDeletedSessionTranscript(
  scope: { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  content: string,
) {
  await replaceSessionEntry(scope, {
    sessionId: scope.sessionId,
    updatedAt: Date.now(),
    displayName: "Retained conversation",
  });
  await appendTranscriptMessage(scope, { message: { role: "user", content } });
  await deleteSessionEntryLifecycle({
    agentId: scope.agentId,
    storePath: scope.storePath,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    archiveTranscript: false,
  });
}
