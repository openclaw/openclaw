import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import {
  assertDatabasePathIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { observeSqliteWorkerCommittedFacts } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import type { OpenClawAgentDatabaseRegistrationCommit } from "./openclaw-agent-db-contract.js";
import {
  agentDatabaseLifecycle,
  closeOpenClawAgentDatabaseByPathAsync,
  revokePendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import {
  captureOpenClawAgentDatabaseRegistration,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
} from "./openclaw-agent-db-registry-listing.js";
import { withAgentDatabaseCloseFence } from "./openclaw-agent-db-resources.js";
import { invalidateOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import { isSameOpenClawAgentDatabasePath } from "./openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

/** Join one unambiguous transient owner before removing its durable registration. */
export async function disposeOpenClawAgentDatabaseByPath(
  databasePath: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const resolvedPath = path.resolve(databasePath);
  const pending = [...agentDatabaseLifecycle.activePending].filter((owner) =>
    isSameOpenClawAgentDatabasePath(owner.path, resolvedPath),
  );
  const retained = [...agentDatabaseLifecycle.retainedCloses].filter((owner) =>
    isSameOpenClawAgentDatabasePath(owner.path, resolvedPath),
  );
  const native = [...agentDatabaseLifecycle.databases.values()].filter((database) =>
    isSameOpenClawAgentDatabasePath(database.path, resolvedPath),
  );
  const database = native[0];
  const identity = readDatabasePathIdentitySync(resolvedPath);
  const context =
    native.length <= 1 && (identity.key.startsWith("file:") || database)
      ? captureOpenClawStateWorkerContext({
          env: options.env ?? (database && agentDatabaseLifecycle.leases.get(database.path)?.env),
        })
      : undefined;
  const paths = [
    ...new Set([
      resolvedPath,
      identity.canonicalPath,
      ...pending.map((owner) => owner.path),
      ...retained.map((owner) => owner.path),
      ...native.map((owner) => owner.path),
    ]),
  ];
  const assertCurrent = () => {
    context?.admission.assertCurrent();
    context?.maintenanceScope?.assertAdmission();
    for (const pathname of paths) {
      assertDatabasePathIdentity(pathname, identity);
    }
  };
  const dispose = async () => {
    for (const pathname of paths) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
    }
    for (const owner of pending) {
      revokePendingAgentDatabaseOpen(owner.path, owner.agentId);
    }
    for (const owner of retained) {
      owner.close();
    }
    await Promise.allSettled(pending.map((owner) => owner.promise));
    assertCurrent();
    if (native.length > 1) {
      throw new Error(`Agent database disposal has multiple native owners: ${resolvedPath}`);
    }
    const closeCapturedPaths = async (additionalPath?: string) => {
      assertCurrent();
      const closePaths = additionalPath ? [...new Set([...paths, additionalPath])] : paths;
      const results = await Promise.allSettled(
        closePaths.map((pathname) => closeOpenClawAgentDatabaseByPathAsync(pathname)),
      );
      assertCurrent();
      throwSqliteLifecycleErrors(
        results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        "Agent disposal resource drainage failed",
      );
      return results.some((result) => result.status === "fulfilled" && result.value);
    };
    if (!context) {
      await closeCapturedPaths();
      return false;
    }
    let target = database && { agentId: database.agentId, path: database.path };
    if (!target) {
      const read = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: context.environment });
      const snapshot = await read.read();
      assertCurrent();
      snapshot.assertCurrent();
      if (snapshot.result.status !== "available") {
        throw new Error("Transient agent disposal cannot read its shared registry");
      }
      const [match, ...ambiguous] = snapshot.result.entries.filter((entry) =>
        isSameOpenClawAgentDatabasePath(entry.path, resolvedPath),
      );
      if (ambiguous.length) {
        throw new Error(`Agent database disposal has multiple registered owners: ${resolvedPath}`);
      }
      if (!match) {
        await closeCapturedPaths();
        return false;
      }
      target = match;
    }
    const owned = target;
    const assertOwned = () => {
      assertCurrent();
      assertDatabasePathIdentity(owned.path, identity);
    };
    return withAgentDatabaseCloseFence({ path: owned.path }, async () => {
      assertOwned();
      invalidateOpenClawAgentDatabaseValidation(owned.path);
      await closeCapturedPaths(owned.path);
      assertOwned();
      const publication = captureOpenClawAgentDatabaseRegistration({
        kind: "remove",
        agentId: owned.agentId,
        agentPath: owned.path,
        admission: context.admission,
        assertPublicationCurrent: context.assertPublicationCurrent,
      });
      let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
      let committed = false;
      const record = (receipt: OpenClawAgentDatabaseRegistrationCommit) => {
        publication.recordCommitted(receipt);
        committed = true;
      };
      const errors: unknown[] = [];
      try {
        const receipt = await runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute({
              type: "agentDatabaseRegistry.remove",
              input: { agentId: owned.agentId, agentPath: owned.path, identity },
            }),
          {
            assertCurrent: assertOwned,
            createAdmission(operation) {
              settlement = operation.settled;
              const admission = createSqliteWorkerWriteAdmission(
                (request) => {
                  assertOwned();
                  if (request.stage === "transaction") {
                    publication.begin();
                  }
                },
                [context.admission.databasePath, owned.path, ...paths],
              )(operation);
              observeSqliteWorkerCommittedFacts(admission.admission, ({ facts }) => {
                if (
                  !isRecord(facts) ||
                  typeof facts.agentId !== "string" ||
                  typeof facts.agentPath !== "string" ||
                  typeof facts.stateDatabasePath !== "string" ||
                  typeof facts.stateDatabaseIdentity !== "string"
                ) {
                  throw new Error("Agent disposal returned an invalid registry receipt");
                }
                record({
                  agentId: facts.agentId,
                  agentPath: facts.agentPath,
                  stateDatabasePath: facts.stateDatabasePath,
                  stateDatabaseIdentity: facts.stateDatabaseIdentity,
                });
              });
              return admission;
            },
          },
        );
        if (!committed) {
          record(receipt);
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        publication.finish(await settlement);
      } catch (error) {
        errors.push(error);
      }
      throwSqliteLifecycleErrors(errors, "Agent disposal and registry publication failed");
      assertOwned();
      return true;
    });
  };
  // A lexical alias and the physical owner retain the same exclusion through publication.
  const fence = (index: number): Promise<boolean> =>
    index === paths.length
      ? dispose()
      : withAgentDatabaseCloseFence({ path: paths[index]! }, () => fence(index + 1));
  return fence(0);
}
