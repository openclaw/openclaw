import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serialize } from "node:v8";
import { INCOGNITO_AGENT_SQLITE_BASENAME } from "../state/openclaw-agent-db.paths.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { acquireWithWait } from "./acquire-with-wait.js";
import { sleepWithAbort } from "./backoff.js";
import { runWithSqliteCoordinator } from "./sqlite-coordinator.js";
import type {
  PreparedSqliteWorkerOpen,
  SqliteWorkerStoreOptions,
  Actor,
  Job,
} from "./sqlite-worker-broker.types.js";
import { readDatabasePathIdentity, type DatabasePathIdentity } from "./sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import {
  acquireStateDatabaseCoordinator,
  StateDatabaseCoordinatorContentionError,
  tryCreateGatewaySchemaFenceDelegate,
  tryCreateStateLifecycleDelegate,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

export function validateSqliteWorkerDatabaseLocator(databasePath: string): void {
  const basename = path.basename(databasePath);
  if (
    !databasePath ||
    databasePath.startsWith("file:") ||
    basename === ":memory:" ||
    basename === INCOGNITO_AGENT_SQLITE_BASENAME
  ) {
    throw new Error(
      "SQLite worker stores require a file-backed filesystem path; in-memory and incognito databases are not supported",
    );
  }
}

export function captureSqliteWorkerOpen(
  options: SqliteWorkerStoreOptions,
  stateContext?: SqliteWorkerStateContext,
  assertCurrent?: () => void,
): PreparedSqliteWorkerOpen {
  const ownedAdmission = options.admission;
  const assertOpening = ownedAdmission
    ? () => {
        assertCurrent?.();
        ownedAdmission.assertCurrent();
      }
    : assertCurrent;
  const databasePath = path.resolve(options.databasePath);
  if (
    options.admission &&
    (!options.existingOnly || !options.admission.identity.startsWith("file:"))
  ) {
    throw new Error("Owned SQLite Worker admission requires an existing physical identity");
  }
  assertOpening?.();
  return {
    assertCurrent: assertOpening,
    ...(options.admission
      ? {
          expectedIdentity: options.admission.identity,
          createOpenAdmission: () => {
            let granted = false;
            return {
              nativeLocations: [databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                if (granted || request.stage !== "open") {
                  throw new Error("SQLite Worker open admission requested out of order");
                }
                assertOpening!();
                if (!grant()) {
                  throw new Error("SQLite Worker open admission expired");
                }
                granted = true;
              }),
            };
          },
        }
      : {}),
    moduleUrl: new URL(options.moduleUrl),
    databasePath,
    input: serialize(options.input),
    existingOnly: options.existingOnly === true,
    ...(stateContext
      ? {
          stateContext: {
            environment: { ...stateContext.environment },
            coordinatorRuntime: { ...stateContext.coordinatorRuntime },
            existingSchemaPath: stateContext.existingSchemaPath,
          },
        }
      : {}),
  };
}

function validateSqliteWorkerModuleUrl(moduleUrl: URL): void {
  if (moduleUrl.protocol !== "file:" || moduleUrl.search || moduleUrl.hash) {
    throw new Error("SQLite worker backend must be a static local module URL");
  }
}

export async function prepareSqliteWorkerDatabaseAdmission(options: PreparedSqliteWorkerOpen) {
  validateSqliteWorkerModuleUrl(options.moduleUrl);
  const databasePath = path.resolve(options.databasePath);
  const inputHash = createHash("sha256").update(options.input).digest("hex");
  const identity = await readDatabasePathIdentity(databasePath);
  options.assertCurrent?.();
  if (options.expectedIdentity && identity.key !== options.expectedIdentity) {
    throw new Error("SQLite Worker path no longer matches its borrowed native owner");
  }
  return { databasePath, inputHash, identity };
}

export function captureSqliteWorkerAdmissionPaths(
  databasePath: string,
  identity: DatabasePathIdentity,
  actors: Iterable<Actor>,
): Set<string> {
  const admittedPaths = new Set([databasePath, identity.canonicalPath]);
  if (
    [...actors].some(
      (entry) =>
        entry.key !== identity.key &&
        [...admittedPaths].some((pathname) => entry.pathReferences.has(pathname)),
    )
  ) {
    throw new Error(
      "SQLite database pathname changed while its worker owner is active; close the existing store first",
    );
  }
  return admittedPaths;
}

export function retainSqliteWorkerAdmissionCleanup(
  actor: Actor,
  retain: PreparedSqliteWorkerOpen["retainCleanup"],
  close: () => Promise<void>,
): void {
  retain?.({
    get pending() {
      return actor.references === 0 && actor.cleanupState === "pending";
    },
    close: () => (actor.references === 0 ? close() : Promise.resolve()),
  });
}

export function retainSqliteWorkerAdmissionPathReferences(actor: Actor, paths: Set<string>) {
  for (const pathname of paths) {
    actor.pathReferences.set(pathname, (actor.pathReferences.get(pathname) ?? 0) + 1);
  }
  return () => {
    for (const pathname of paths) {
      const references = actor.pathReferences.get(pathname) ?? 0;
      if (references > 1) {
        actor.pathReferences.set(pathname, references - 1);
      } else {
        actor.pathReferences.delete(pathname);
      }
    }
  };
}

export async function resolveOpenedSqliteWorkerIdentity(
  databasePath: string,
  previous: DatabasePathIdentity,
  isOwnedElsewhere: (key: string) => boolean,
): Promise<string> {
  const openedIdentity = await readDatabasePathIdentity(databasePath);
  const physical = openedIdentity.key;
  if (openedIdentity.canonicalPath !== previous.canonicalPath) {
    throw new Error("SQLite database canonical pathname changed during open");
  }
  if (!physical.startsWith("file:")) {
    throw new Error("SQLite worker backend did not establish its database file");
  }
  if (isOwnedElsewhere(physical)) {
    throw new Error("SQLite database identity collided with an existing worker owner during open");
  }
  if (previous.key.startsWith("file:") && physical !== previous.key) {
    throw new Error("SQLite database file identity changed during open");
  }
  return physical;
}

export function findUnclaimedSharedStateActors(
  actors: Iterable<Actor>,
  databasePath: string,
): Actor[] {
  const pathname = path.resolve(databasePath);
  return [...actors].filter(
    (actor) =>
      actor.stateContext !== undefined &&
      actor.references === 0 &&
      actor.cleanupState === "pending" &&
      actor.databasePath === pathname,
  );
}

export async function resolveSqliteWorkerModuleUrl(sourceUrl: URL) {
  const modulePath = await realpath(fileURLToPath(sourceUrl));
  const moduleUrl = pathToFileURL(modulePath).href;
  if (!/\.[cm]?[jt]s$/.test(modulePath) || !(await stat(modulePath)).isFile()) {
    throw new Error("SQLite worker backend must identify a JavaScript or TypeScript file");
  }
  return { modulePath, moduleUrl };
}

export function assertSqliteWorkerActorReusable(
  actor: Actor,
  moduleUrl: string,
  inputHash: string,
  stateContext: SqliteWorkerStateContext | undefined,
): void {
  if (actor.slot.failed) {
    throw actor.slot.failed;
  }
  if (actor.moduleUrl !== moduleUrl || actor.inputHash !== inputHash) {
    throw new Error("SQLite database already belongs to another worker backend");
  }
  if (actor.stateContext?.existingSchemaPath !== stateContext?.existingSchemaPath) {
    throw new Error("Shared-state worker schema policy changed; close its actor first");
  }
}

function prepareSqliteWorkerActorContext(actor: Actor | undefined, job: Job): void {
  const { request } = job;
  const stateContext = request.stateContext ?? actor?.stateContext;
  if (actor && stateContext) {
    if (
      actor.stateContext?.coordinatorRuntime.directory !== stateContext.coordinatorRuntime.directory
    ) {
      throw new Error("Shared-state worker coordinator scope changed; close its actor first");
    }
    if (actor.stateContext?.existingSchemaPath !== stateContext.existingSchemaPath) {
      throw new Error("Shared-state worker schema policy changed; close its actor first");
    }
    request.stateContext = stateContext;
    if (!actor.cleanupState && !actor.gatewaySchemaFence) {
      const delegate = tryCreateGatewaySchemaFenceDelegate({
        databasePath: actor.databasePath,
        runtimeDirectory: stateContext.coordinatorRuntime.directory,
        actorId: String(actor.id),
      });
      if (delegate) {
        actor.gatewaySchemaFence = delegate;
        job.gatewaySchemaFence = { actor, delegate };
        try {
          request.gatewaySchemaFence = delegate.port;
        } catch (error) {
          actor.cleanupState = "pending";
          throw error;
        }
      }
    }
  }
}

export function prepareSqliteWorkerLifecycle(
  job: Job,
  actor: Actor | undefined,
  assertDispatchable: () => void,
  signal?: AbortSignal,
): void | Promise<void> {
  const context = job.request.stateContext ?? actor?.stateContext;
  if (!actor || !context) {
    if (job.requireStateLifecycle) {
      throw new Error("SQLite worker lifecycle custody requires its captured state owner");
    }
    return undefined;
  }
  // Retirement must veto pooling on the physical owner, including a borrowed lease.
  const runtime =
    job.request.type === "close"
      ? { ...context.coordinatorRuntime, keepAlive: false }
      : context.coordinatorRuntime;
  return withStateDatabaseCoordinatorRuntimeDirectory(runtime, () => {
    const prepare = () => {
      assertDispatchable();
      prepareSqliteWorkerActorContext(actor, job);
      const schemaFence = actor.gatewaySchemaFence
        ? undefined
        : job.maintenanceScope?.createSchemaFenceDelegate({
            databasePath: actor.databasePath,
            runtimeDirectory: context.coordinatorRuntime.directory,
            actorId: `${actor.id}:${job.request.id}`,
          });
      if (schemaFence) {
        job.maintenanceSchemaFence = { actor, delegate: schemaFence };
        job.request.maintenanceSchemaFence = schemaFence.port;
      }
      const delegate = tryCreateStateLifecycleDelegate({
        databasePath: actor.databasePath,
        actorId: `${actor.id}:${job.request.id}`,
      });
      if (!delegate && job.requireStateLifecycle) {
        throw new Error("SQLite worker did not retain its required lifecycle custody");
      }
      if (delegate) {
        job.stateLifecycle = { actor, delegate };
        job.request.stateLifecycle = delegate.port;
      }
    };
    if (!job.requireStateLifecycle) {
      prepare();
      return undefined;
    }
    let acquisitionError: unknown;
    return acquireWithWait({
      deadlineMs: performance.now() + OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      pollIntervalMs: 25,
      maxPollIntervalMs: 250,
      sleep: (ms) =>
        sleepWithAbort(ms, signal).catch((error: unknown) => {
          signal?.throwIfAborted();
          throw error;
        }),
      shouldRetry: (error) =>
        error === acquisitionError &&
        error instanceof StateDatabaseCoordinatorContentionError &&
        error.family === "state-lifecycle",
      acquire: () => {
        acquisitionError = undefined;
        assertDispatchable();
        let coordinator: ReturnType<typeof acquireStateDatabaseCoordinator>;
        try {
          coordinator = acquireStateDatabaseCoordinator({
            databasePath: actor.databasePath,
            busyTimeoutMs: 0,
          });
        } catch (error) {
          acquisitionError = error;
          throw error;
        }
        // Only acquisition retries. Install delegates once, before releasing this real reference.
        runWithSqliteCoordinator(coordinator, "SQLite worker lifecycle delegation", prepare);
      },
    });
  });
}

export function releaseSqliteWorkerLifecycle(job: Job): void {
  const errors: unknown[] = [];
  const unpostedGatewayFence = job.nativeDispatched ? undefined : job.gatewaySchemaFence;
  for (const held of [job.stateLifecycle, job.maintenanceSchemaFence, unpostedGatewayFence]) {
    if (!held) {
      continue;
    }
    const { actor, delegate } = held;
    try {
      delegate.release();
    } catch (error) {
      if (!delegate.closed) {
        actor.cleanupState = "pending";
      }
      if (!delegate.closed && held !== unpostedGatewayFence) {
        actor.pendingStateLifecycles.add(delegate);
        job.maintenanceScope?.own(delegate, "shared-resources", () => {
          try {
            delegate.release();
          } finally {
            if (delegate.closed) {
              actor.pendingStateLifecycles.delete(delegate);
            }
          }
        });
      }
      errors.push(error);
    } finally {
      if (held === unpostedGatewayFence && delegate.closed) {
        actor.gatewaySchemaFence = undefined;
      }
    }
  }
  job.gatewaySchemaFence = undefined;
  job.stateLifecycle = undefined;
  job.maintenanceSchemaFence = undefined;
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "SQLite worker coordinator cleanup failed");
  }
}

export function releaseSqliteWorkerActorCoordinators(actor: Actor): void {
  for (const delegate of actor.pendingStateLifecycles) {
    try {
      delegate.release();
    } finally {
      if (delegate.closed) {
        actor.pendingStateLifecycles.delete(delegate);
      }
    }
  }
  const delegation = actor.gatewaySchemaFence;
  if (!delegation) {
    return;
  }
  try {
    delegation.release();
  } finally {
    if (delegation.closed) {
      actor.gatewaySchemaFence = undefined;
    }
  }
}
