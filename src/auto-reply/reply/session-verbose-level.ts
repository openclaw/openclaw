import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import type {
  SessionEntryReadOnlyWorkerScope,
  SessionEntryReadScope,
} from "../../config/sessions/session-accessor.types.js";
import { readRetainedSessionEntryFacts } from "../../config/sessions/session-entry-read-facts.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";

/** Prepare once; synchronous progress callbacks consume the session owner's write receipts. */
export async function prepareSessionVerboseLevelReader(params: {
  scope?: SessionEntryReadScope;
  initialLevel?: string;
  assertCurrent?: () => void;
}): Promise<() => VerboseLevel | undefined> {
  let initialLevel = normalizeVerboseLevel(params.initialLevel ?? "");
  let preparedScope: SessionEntryReadOnlyWorkerScope | undefined;
  let native = false;
  const assertCurrent = params.assertCurrent ?? (() => {});
  if (params.scope) {
    try {
      await withSessionEntryReadOnlyInWorker(
        { ...params.scope, projection: "list", hydrateSkillPromptRefs: false },
        assertCurrent,
        async (read, owner) => {
          if (read.ok) {
            initialLevel = normalizeVerboseLevel(read.value?.verboseLevel ?? "");
          }
          preparedScope = owner.scope;
          native = owner.kind === "native" || owner.kind === "incognito";
        },
      );
    } catch {
      // A maintenance failure keeps the admitted turn preference until the next preparation.
    }
  }
  assertCurrent();
  return () => {
    try {
      if (native && params.scope) {
        // The process-held incognito owner retains its native contract until its cutover.
        return normalizeVerboseLevel(loadSessionEntryReadOnly(params.scope)?.verboseLevel ?? "");
      }
      if (preparedScope) {
        const read = readRetainedSessionEntryFacts(
          { agentId: preparedScope.databaseAgentId, path: preparedScope.storePath },
          {
            sessionKeys: [resolveSqliteSessionKey(preparedScope.sessionKey, preparedScope.agentId)],
            projection: "exact",
            snapshotFields: [],
          },
        );
        if (read) {
          return normalizeVerboseLevel(read.entries[0]?.entry.verboseLevel ?? "");
        }
      }
    } catch {
      // An unavailable receipt keeps the admitted preference, without a synchronous reread.
    }
    return initialLevel;
  };
}
