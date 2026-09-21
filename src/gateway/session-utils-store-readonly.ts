import { readExactSessionEntryRowValidated } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import type { SessionEntryReadSource } from "../config/sessions/session-accessor.types.js";
import { readWithCanonicalSessionAdmission } from "../config/sessions/session-canonical-key.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import { resolveGatewaySessionStoreReadResults } from "./session-utils-store-selection.js";

/** Auxiliary metadata never chooses one of several matching canonical source rows. */
export function readGatewaySessionEntryFromSources(
  sessionKey: string,
  sources: readonly SessionEntryReadSource[],
  current?: { source: SessionEntryReadSource; entry: SessionEntry | undefined },
): SessionEntry | undefined {
  if (sources.length === 0) {
    return undefined;
  }
  const selected = resolveGatewaySessionStoreReadResults({
    canonicalKey: sessionKey,
    scanTargets: [sessionKey],
    deferCanonicalValidation: true,
    reads: sources.map((source) => ({ storePath: source.path, readSource: source })),
    readStore: ({ readSource }) => {
      if (
        current &&
        readSource.path === current.source.path &&
        readSource.agentId === current.source.agentId
      ) {
        return current.entry ? { [sessionKey]: current.entry } : {};
      }
      try {
        const result = withScopedOpenClawAgentDatabaseReadOnly(
          (database) =>
            readWithCanonicalSessionAdmission(
              database,
              () => readExactSessionEntryRowValidated(database, sessionKey, "list")?.entry,
            ),
          readSource,
        );
        return result.found && result.value ? { [sessionKey]: result.value } : {};
      } catch {
        // Preserve the existing unavailable auxiliary store as an unclassified source.
        return {};
      }
    },
  });
  return selected.canonicalValidationError ? undefined : selected.match?.entry;
}
