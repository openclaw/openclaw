import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
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
  const admitted = captureOpenClawAgentDatabaseReadValidation({
    agentId: toDatabaseOptions(logical).agentId,
    path: storePath,
  });
  const prepared = admitted?.canonicalPath === storePath ? admitted : undefined;
  const candidates = prepared ? [] : captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  return {
    resolve(resolved: ResolvedSqliteScope) {
      const options = {
        ...toDatabaseOptions(resolved),
        path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
      };
      const identity = prepared
        ? {
            key: `file:${prepared.validation.identity}`,
            birthtime: prepared.validation.birthtime,
            canonicalPath: prepared.canonicalPath,
          }
        : identities.get(assertSessionStoreReadCandidate(options.path, candidates));
      if (!identity) {
        throw new Error(changedMessage);
      }
      const assertReadCurrent = () => {
        if (prepared) {
          prepared.assertCurrent();
          if (options.path !== prepared.canonicalPath) {
            throw new Error(changedMessage);
          }
        } else {
          assertSessionStoreReadCandidate(options.path, candidates);
          assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
        }
      };
      return {
        options,
        identity,
        source: {
          agentId: options.agentId,
          path: options.path,
          databaseIdentity: identity.key.slice(5),
          databaseBirthtime: identity.birthtime,
        },
        assertReadCurrent,
        assertCurrent: () => {
          assertReadCurrent();
          // Privileged consumers retain direct identity checks before write admission.
          if (prepared) {
            assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
          }
        },
      };
    },
  };
}
