import { threadId, type MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { assertStateDatabaseAccessAllowed } from "../../infra/gateway-state-owner.js";
import { withSqliteDatabaseAdmissionExchange } from "../../infra/sqlite-database-admission.js";
import { retainSqliteWriteAdmissionService } from "../../infra/sqlite-transaction.js";
import { exchangeSqliteDatabaseAdmissions } from "../../infra/sqlite-worker-database-admission-relay.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveQuarantineStorePath,
} from "../../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  sqliteMutationWorkerThreadId,
  terminateSqliteMutationWorker,
  type SqliteMutationWorkerTransport,
} from "./session-accessor.sqlite-worker-transport.js";

export type SqliteMutationWorkerCoordination = {
  actorId: string;
  databasePath: string;
  stateContext: SqliteWorkerStateContext;
  databaseAdmission?: MessagePort;
  reconciliation?: { identity: string; admission: MessagePort };
};

/** The request owns its native worker until a result or confirmed exit settles. */
export async function withSqliteMutationWorkerCoordination<T>(
  context: OpenClawStateWorkerContext,
  transport: SqliteMutationWorkerTransport,
  operationId: number,
  run: (coordination: SqliteMutationWorkerCoordination) => Promise<T>,
  assertRequestCurrent?: () => void,
): Promise<T> {
  const worker = transport.channel;
  const actorId = `${sqliteMutationWorkerThreadId(transport)}:${operationId}`;
  const preparingError = () => {};
  worker.on("error", preparingError);
  try {
    return await withSqliteWorkerLifecycleCoordination(
      context,
      actorId,
      run,
      async () => {
        await terminateSqliteMutationWorker(transport);
      },
      "retained",
      assertRequestCurrent,
    );
  } finally {
    worker.off("error", preparingError);
  }
}

/** Join uncertain native work before the transport can release its owned resources. */
export async function withSqliteWorkerLifecycleCoordination<T>(
  context: OpenClawStateWorkerContext,
  actorId: string,
  run: (coordination: SqliteMutationWorkerCoordination) => Promise<T>,
  settleFailure: () => Promise<void>,
  mode: "retained" | "reconciliation" = "retained",
  assertRequestCurrent?: () => void,
): Promise<T> {
  const identity = context.admission.identity.key;
  let opened = false;
  const admission =
    mode === "reconciliation"
      ? createSqliteWorkerOperationAdmission((request, grant) => {
          const facts = request.facts;
          if (
            request.stage !== "prepare" ||
            !isRecord(facts) ||
            facts.kind !== "transcript-reconciliation" ||
            facts.actorId !== actorId ||
            (facts.phase !== "open" && facts.phase !== "close")
          ) {
            throw new Error("Transcript reconciliation admission differs from its operation");
          }
          // Read revocation seals new work, but cannot revoke cleanup of an accepted open.
          if (facts.phase === "open" || !opened) {
            context.admission.assertCurrent();
          }
          assertExistingDatabaseIdentity(context.admission.databasePath, identity);
          assertStateDatabaseAccessAllowed(context.admission.databasePath);
          if (!grant()) {
            throw new Error("Transcript reconciliation admission expired");
          }
          opened ||= facts.phase === "open";
        })
      : assertRequestCurrent
        ? createSqliteWorkerOperationAdmission(() => {
            throw new Error("SQLite mutation file admission does not grant transaction authority");
          })
        : undefined;
  if (admission && assertRequestCurrent) {
    admission.bindDatabaseAuthority({
      databasePath: context.admission.databasePath,
      assertRequest: assertRequestCurrent,
      assertAccess() {
        context.admission.assertCurrent();
        // First creation stays path-bound until the native lease publishes its file identity.
        const current = context.admission.identity;
        if (current.key.startsWith("file:")) {
          assertExistingDatabaseIdentity(
            context.admission.databasePath,
            current.key,
            current.birthtime,
          );
        }
        context.maintenanceScope?.assertAdmission();
      },
      assertCreate(location) {
        // Raw agent admission may create shared state and its first integrity receipt.
        if (
          location !== resolveIdentityPathViaExistingAncestorSync(context.admission.databasePath) &&
          location !==
            resolveIdentityPathViaExistingAncestorSync(
              resolveQuarantineStorePath(context.environment),
            )
        ) {
          throw new Error("SQLite mutation creation target differs from its captured companions");
        }
      },
      acquireSchema() {
        throw new Error("SQLite mutation file admission does not grant schema maintenance");
      },
    });
  }
  const releaseService = admission
    ? retainSqliteWriteAdmissionService([context.admission.databasePath], () => admission.service())
    : undefined;
  try {
    return await run({
      actorId,
      databasePath: context.admission.databasePath,
      stateContext: { environment: context.environment },
      ...(admission
        ? mode === "reconciliation"
          ? { reconciliation: { identity, admission: admission.port } }
          : { databaseAdmission: admission.port }
        : {}),
    });
  } catch (error) {
    try {
      await settleFailure();
    } catch (exitError) {
      throw new AggregateError(
        [admission?.failure ?? error, exitError],
        "SQLite mutation and Worker exit failed",
        { cause: exitError },
      );
    }
    // A refused grant retires the worker; confirmed exit must not hide the owner's refusal.
    throw admission?.failure ?? error;
  } finally {
    admission?.finish();
    releaseService?.();
  }
}

export async function runWithSqliteMutationWorkerCoordination<
  T,
  Options extends OpenClawAgentDatabaseOptions,
>(
  coordination: SqliteMutationWorkerCoordination,
  operationId: number,
  options: Options,
  run: (options: Options) => Promise<T>,
): Promise<T> {
  if (
    coordination.actorId !== `${threadId}:${operationId}` ||
    resolveOpenClawStateSqlitePath(coordination.stateContext.environment) !==
      coordination.databasePath
  ) {
    throw new Error("SQLite mutation Worker shared-state owner changed");
  }
  const execute = () =>
    run({
      ...options,
      env: { ...options.env, ...coordination.stateContext.environment },
    });
  const admission = coordination.databaseAdmission;
  if (!admission) {
    return await execute();
  }
  let active = true;
  try {
    return await withSqliteDatabaseAdmissionExchange((facts, location, create) => {
      if (!active) {
        throw new Error("SQLite mutation file admission outlived its request");
      }
      if (create) {
        // First-open creation can run inside this worker's live schema lease.
        assertStateDatabaseAccessAllowed(coordination.databasePath);
      }
      return exchangeSqliteDatabaseAdmissions(admission, facts, location, create);
    }, execute);
  } finally {
    active = false;
    admission.close();
  }
}

/** Reconciliation retains its native handles and durable agent lease between grants. */
export async function runSqliteReconciliationLifecyclePhase<T>(
  coordination: SqliteMutationWorkerCoordination,
  phase: "open" | "close",
  operation: () => T,
  onUnsettled: () => void,
): Promise<T> {
  const retained = coordination.reconciliation;
  if (!retained) {
    throw new Error("Transcript reconciliation requires its retained admission");
  }
  try {
    return withSqliteWorkerOperationAdmission({ port: retained.admission }, () => {
      requestSqliteWorkerOperationAdmission({
        stage: "prepare",
        facts: { kind: "transcript-reconciliation", actorId: coordination.actorId, phase },
      });
      assertExistingDatabaseIdentity(coordination.databasePath, retained.identity);
      return operation();
    });
  } catch (error) {
    onUnsettled();
    throw error;
  }
}
