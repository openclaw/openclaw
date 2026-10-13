import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";

/** Capture before discovery yields, then bind its selected physical database. */
export function captureSessionStoreReadTarget(scope: SessionAccessScope, changedMessage: string) {
  const logical = resolveSqliteScope({ ...scope, storePath: undefined });
  const storePath =
    logical.path ?? scope.storePath ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  return {
    resolve(resolved: ResolvedSqliteScope) {
      const options = {
        ...toDatabaseOptions(resolved),
        path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
      };
      const identity = identities.get(assertSessionStoreReadCandidate(options.path, candidates));
      if (!identity) {
        throw new Error(changedMessage);
      }
      return {
        options,
        identity,
        source: {
          agentId: options.agentId,
          path: options.path,
          databaseIdentity: identity.key.slice(5),
          databaseBirthtime: identity.birthtime,
        },
        assertCurrent: () => {
          assertSessionStoreReadCandidate(options.path, candidates);
          assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
        },
      };
    },
  };
}
