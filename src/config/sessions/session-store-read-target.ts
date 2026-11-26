import {
  assertExistingDatabaseIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
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
import { prepareSessionStoreCandidatesInWorker } from "./session-transcript-worker-resources.js";

/** Prepare the original candidate identities before binding the selected physical database. */
export async function captureSessionStoreReadTarget(
  scope: SessionAccessScope,
  changedMessage: string,
) {
  const logical = resolveSqliteScope({ ...scope, storePath: undefined });
  const storePath =
    logical.path ?? scope.storePath ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const admitted = await captureOpenClawAgentDatabaseReadValidation({
    agentId: toDatabaseOptions(logical).agentId,
    path: storePath,
  });
  const prepared = admitted?.canonicalPath === storePath ? admitted : undefined;
  const candidates = prepared
    ? []
    : (await prepareSessionStoreCandidatesInWorker({ storePath })).candidates;
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const nativeCandidates = candidates.map((candidate) => ({
    path: candidate.path,
    physicalPath: candidate.physicalPath,
    scope: candidate.scope,
  }));
  return {
    async resolve(resolved: ResolvedSqliteScope) {
      const options = {
        ...toDatabaseOptions(resolved),
        path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
      };
      const validateRead = (sources: readonly { path: string; identity: DatabasePathIdentity }[]) =>
        prepareSessionStoreCandidatesInWorker({
          validate: {
            readCustody: prepared
              ? []
              : [{ sourcePath: options.path, candidates: nativeCandidates }],
            candidates: [],
            sources,
          },
        });
      const selected = prepared ? undefined : await validateRead([]);
      const selectedPath =
        selected && "readPaths" in selected ? selected.readPaths?.[0] : undefined;
      const identity = prepared
        ? {
            key: `file:${prepared.validation.identity}`,
            birthtime: prepared.validation.birthtime,
            canonicalPath: prepared.canonicalPath,
          }
        : selectedPath
          ? identities.get(selectedPath)
          : undefined;
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
          assertSessionStoreReadCandidate(options.path, nativeCandidates);
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
        async assertReadCurrentAsync() {
          if (prepared) {
            assertReadCurrent();
          } else {
            await validateRead([{ path: options.path, identity }]);
          }
        },
        async assertCurrentAsync() {
          if (prepared) {
            assertReadCurrent();
          }
          await validateRead([{ path: options.path, identity }]);
          if (prepared) {
            assertReadCurrent();
          }
        },
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
