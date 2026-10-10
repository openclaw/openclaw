import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../../config/sessions/session-incognito-binding.js";
import type { FollowupRun } from "./types.js";

export function createFollowupTranscriptTarget(source: FollowupRun) {
  const sessionKey = normalizeOptionalString(source.run.sessionKey) ?? source.run.sessionId;
  const storePath = resolveSessionStorePathCore(source.run.config.session?.store, {
    agentId: source.run.agentId,
  });
  const scope = { storePath, sessionKey, agentId: source.run.agentId, clone: false };
  const incognito = captureIncognitoSessionSource(scope);
  const target = (sessionEntry: ReturnType<typeof loadSessionEntryReadOnly>) => ({
    sessionId: sessionEntry?.sessionId ?? source.run.sessionId,
    sessionKey,
    sessionEntry,
    storePath,
    agentId: source.run.agentId,
    cwd: source.run.cwd ?? source.run.workspaceDir,
    config: source.run.config,
  });
  if (!incognito) {
    return () => target(loadSessionEntryReadOnly(scope));
  }
  return async () =>
    target(
      await readSessionEntryReadOnlyInWorker(scope, () => {
        incognito.admissionSignal?.throwIfAborted();
        if ("kind" in incognito) {
          incognito.assertCurrent();
        } else {
          incognito.actor.assertReadable();
        }
      }),
    );
}
