import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { requireNativeDatabaseFile } from "../infra/database-engine/physical-facts.js";
import {
  getStateDatabaseSchemaLease,
  prepareStateDatabaseReadAccess,
} from "../infra/gateway-state-owner.js";
import { statIfExists } from "../infra/path-existence.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { hasVerifiedLiveSqliteOwner } from "../infra/sqlite-live-owner.js";
import { retainSnapshotTempDirectory } from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationFromOwnedDatabase } from "../infra/sqlite-readonly-location.js";
import type {
  AsyncPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
} from "../infra/sqlite-readonly-location.types.js";
import { runSqliteReadOnlyOperation } from "../infra/sqlite-readonly-worker.js";
import {
  captureReusableSqliteSource,
  isSqliteSnapshotReuseActive,
  leaseReusableSqliteSnapshot,
  publishReusableSqliteSnapshot,
} from "../infra/sqlite-snapshot-reuse.js";
import {
  prepareSqliteReadOnlyLocationAwaited,
  startSqliteReadOnlyLocationAsync,
} from "../infra/sqlite-snapshot-source.js";
import type { DatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
import { isUpdateRunAdmissionReadCommand } from "../infra/update-run-admission.types.js";
import {
  borrowOpenClawStateDatabaseForAsyncRead,
  retainOpenClawStateDatabaseForIndependentRead,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { canReadWarmNativeSourceIndependently } from "./openclaw-state-db-readonly-reuse.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
  OpenClawStateReadOptions,
  OpenClawStateReadOutcome,
  OpenClawStateReadReceipt,
  OpenClawStateReadReply,
  ReadResource,
  RetainedReadScope,
} from "./openclaw-state-read.types.js";
import type { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

export type OpenClawStateReadCompletion = Promise<OpenClawStateReadReply | undefined>;

export type StateReadReply<Type extends OpenClawStateReadCommand["type"]> = Extract<
  OpenClawStateReadReply,
  { ok: true }
> & { type: Type };

export function isStateReadReply<Type extends OpenClawStateReadCommand["type"]>(
  reply: OpenClawStateReadReply,
  type: Type,
): reply is StateReadReply<Type> {
  return reply.ok && reply.type === type;
}

/**
 * Reads repeat far more often than this owner commits, and each backup copies the whole
 * file. A retained owner of a replaced path keeps its own bytes, so it never shares them.
 */
async function prepareOwnedStateReadImage(
  database: DatabaseSync,
  pathname: string,
  expectedIdentity: DatabaseFileIdentity | undefined,
  authority: { assertCurrent: () => void },
  signal: AbortSignal,
) {
  const lease =
    expectedIdentity && !database.isTransaction
      ? leaseReusableSqliteSnapshot(pathname, expectedIdentity, { logicalReader: true })
      : undefined;
  if (lease) {
    return lease;
  }
  const source = expectedIdentity ? captureReusableSqliteSource(pathname) : undefined;
  const prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(
    database,
    authority.assertCurrent,
    signal,
    "async",
  );
  return source
    ? publishReusableSqliteSnapshot(pathname, source, prepared, () => prepared.cleanupAsync(), {
        logicalOnly: true,
      })
    : prepared;
}

type Selection = {
  pathname: string;
  snapshot?: {
    postgresSnapshot?: string;
    location: string;
    cleanupRoot?: string;
    release?(): void | Promise<void>;
  };
  scopes: RetainedReadScope[];
  context: ReturnType<typeof captureOpenClawStateReadWorkerContext>;
  preserveArtifacts: boolean;
  preferIndependentWarmRead?: true;
  snapshotPreparation?: "awaited";
  onChunk?: OpenClawStateReadOptions["onChunk"];
  onChunkAsync?: OpenClawStateReadOptions["onChunkAsync"];
  onDiagnosticPhase?: OpenClawStateReadOptions["onDiagnosticPhase"];
  controller: AbortController;
  signal: AbortSignal;
  callerSignal?: AbortSignal;
  receipt: OpenClawStateReadReceipt;
  mapError: OpenClawStateReadOptions["mapError"];
};

/** One async owner joins the query and native cleanup before releasing its snapshot. */
export function startOpenClawStateReadOperation(
  command: OpenClawStateReadCommand,
  selection: Selection,
): OpenClawStateReadCompletion {
  const { pathname, snapshot, scopes, context, preserveArtifacts, controller, signal, receipt } =
    selection;
  const observe = selection.onDiagnosticPhase;
  type ReadTransport = ReturnType<
    ReturnType<typeof captureOpenClawStateReadSource>["createTransport"]
  >;
  let transport: ReadTransport | undefined;
  let unregisterSource: (() => void) | undefined;
  let borrowed: ReturnType<typeof retainOpenClawStateDatabaseForIndependentRead>;
  let prepared: AsyncPreparedSqliteReadOnlyLocation | undefined;
  let preparation: RetainedSqliteSnapshotPreparation | undefined;
  let retirement: Promise<void> | undefined;
  let preparationClose: RetainedOperation<void> | undefined;
  let snapshotCleanup: RetainedOperation<boolean> | undefined;
  let startSnapshotCleanup: (() => RetainedOperation<boolean>) | undefined;
  let releasePreparedSource: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let stateAccess: Awaited<ReturnType<typeof prepareStateDatabaseReadAccess>>;
  let cleaned = false;
  const authority: OpenClawStateReadAuthority = {
    signal,
    assertCurrent() {
      signal.throwIfAborted();
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      openClawStateDatabaseCache.assertOpenClawStateDatabaseOpenAllowed(
        pathname,
        "cached-read",
        stateAccess,
      );
    },
  };

  const closeTransport = async () => {
    if (!transport) {
      return;
    }
    retirement ??= transport.startClose();
    try {
      observe?.("transport-close-started");
      await retirement;
      observe?.("transport-close-returned");
    } catch (error) {
      retirement = undefined;
      throw error;
    }
  };

  const cleanup = (): Promise<void> => {
    if (cleaned) {
      return Promise.resolve();
    }
    return (closing ??= (async () => {
      observe?.("cleanup-started");
      await closeTransport();
      releasePreparedSource?.();
      releasePreparedSource = undefined;
      if (prepared) {
        observe?.("snapshot-cleanup-started");
        snapshotCleanup = startSnapshotCleanup?.();
        const removed = snapshotCleanup
          ? await snapshotCleanup.result
          : await prepared.cleanupAsync();
        if (!removed) {
          throw new Error(
            `Shared-state read snapshot cleanup failed: ${prepared.cleanupRoot ?? pathname}`,
          );
        }
        prepared = undefined;
        snapshotCleanup = undefined;
        observe?.("snapshot-cleanup-returned");
      }
      if (preparation) {
        preparationClose ??= preparation.startClose();
        try {
          observe?.("preparation-close-started");
          await preparationClose.result;
          observe?.("preparation-close-returned");
        } catch (error) {
          preparationClose = undefined;
          throw error;
        }
        preparation = undefined;
        preparationClose = undefined;
      }
      observe?.("borrow-release-started");
      borrowed?.release();
      observe?.("borrow-release-returned");
      observe?.("inherited-release-started");
      await snapshot?.release?.();
      observe?.("inherited-release-returned");
      cleaned = true;
      unregister();
      unregisterSource?.();
      for (const scope of scopes) {
        scope.resources.delete(resource);
      }
      observe?.("cleanup-returned");
    })().finally(() => {
      closing = undefined;
    }));
  };
  const resource: ReadResource = {
    async close() {
      controller.abort(new Error("Shared-state read admission closed"));
      // Pending preparation must stop, but a published snapshot still belongs to its reader.
      if (!prepared) {
        preparationClose ??= preparation?.startClose();
      }
      await closeTransport();
      // The public result reports query failures; shutdown still joins native cleanup.
      await producer.catch(() => undefined);
      await cleanup();
    },
  };
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (
        !identity ||
        identity.key === context.admission.identity.key ||
        identity.canonicalPath === context.admission.identity.canonicalPath
      ) {
        await resource.close();
      }
    },
  });
  context.maintenanceScope?.own(resource, "shared-resources", () => resource.close());
  for (const scope of scopes) {
    scope.resources.add(resource);
  }

  function consume(read: OpenClawStateReadOutcome): OpenClawStateReadReply {
    const admitted =
      "error" in read
        ? read.sourceAdmitted
        : read.value.type !== "admit" && read.value.sourceAdmitted;
    if (admitted === true) {
      receipt.phase = "read";
    } else if (admitted === false && receipt.phase !== "read") {
      receipt.phase = "before-read";
    }
    if ("error" in read) {
      throw read.error;
    }
    if (admitted === true) {
      borrowed?.observe();
    }
    return read.value;
  }

  async function query(selectedTransport: ReadTransport) {
    if (prepared) {
      releasePreparedSource = retainSnapshotTempDirectory(
        prepared.cleanupRoot ?? path.dirname(prepared.location),
      );
    }
    receipt.phase = command.type === "admit" ? "before-read" : "unobserved";
    const read = selectedTransport.startRead(
      {
        context,
        location: prepared?.location ?? snapshot?.location ?? pathname,
        checkFreshAdmission: !borrowed,
        expectedIdentity:
          (!snapshot && !prepared) || snapshot?.location === pathname
            ? context.admission.identity.key
            : undefined,
        snapshotRoot: prepared?.cleanupRoot ?? snapshot?.cleanupRoot,
        postgresSnapshot: snapshot?.postgresSnapshot,
      },
      authority,
    );
    const outcome = await read;
    observe?.("result-consumption-started");
    const reply = consume(outcome);
    observe?.("result-consumption-returned");
    return reply;
  }

  async function run(): OpenClawStateReadCompletion {
    observe?.("transport-creation-started");
    const source = captureOpenClawStateReadSource();
    const selectedTransport = source.createTransport(
      command,
      selection.onChunk,
      selection.onChunkAsync,
      selection.snapshotPreparation === "awaited",
      observe,
    );
    transport = selectedTransport;
    unregisterSource = source.own(() => resource.close());
    observe?.("transport-creation-returned");
    observe?.("database-access-started");
    stateAccess = await prepareStateDatabaseReadAccess(context.admission);
    observe?.("database-access-returned");
    signal.throwIfAborted();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    if (command.type === "admit") {
      return query(selectedTransport);
    }
    const native =
      !snapshot && preserveArtifacts
        ? borrowOpenClawStateDatabaseForAsyncRead(pathname, "cached-read", stateAccess)
        : undefined;
    borrowed =
      native ??
      (!snapshot && !preserveArtifacts
        ? retainOpenClawStateDatabaseForIndependentRead(pathname, "cached-read", stateAccess)
        : undefined);
    const independentWarmSource =
      native &&
      selection.preferIndependentWarmRead &&
      canReadWarmNativeSourceIndependently(
        native.database,
        pathname,
        context.admission.identity.key,
      );
    if (!snapshot && !borrowed && !(await statIfExists(pathname))) {
      authority.assertCurrent();
      return undefined;
    }
    if (!snapshot && preserveArtifacts && !independentWarmSource) {
      const currentMetadata =
        (command.type === "plugins.metadata.read" ||
          command.type === "config.health.read" ||
          isUpdateRunAdmissionReadCommand(command)) &&
        !context.existingSchemaPath &&
        !context.maintenanceScope &&
        !getStateDatabaseSchemaLease(pathname) &&
        (!native ||
          (!isPostgresSqlConnection(native.database.db) &&
            canReadWarmNativeSourceIndependently(
              native.database,
              pathname,
              context.admission.identity.key,
            ))) &&
        (hasVerifiedLiveSqliteOwner(pathname) || readSqliteDatabaseCleanClose(pathname));
      if (!native || currentMetadata) {
        observe?.("fresh-validation-started");
        await selectedTransport.startValidateFresh(context, authority);
        observe?.("fresh-validation-returned");
      }
      if (currentMetadata) {
        // Metadata reads pin the admitted source in a child before copying a warm
        // writer's unrelated state. Replaced paths and retained/private snapshots
        // keep their original recovery owner; the native borrow lasts through close.
        authority.assertCurrent();
        const inspected = await runSqliteReadOnlyOperation(
          pathname,
          { type: "startupMetadata.readCurrent", input: command },
          {
            source: "canonical",
            expectedIdentity: context.admission.identity.key,
            env: context.environment,
            signal,
          },
        );
        authority.assertCurrent();
        if (inspected) {
          const result = inspected.value;
          if (!result.ok) {
            const error = new Error("Startup metadata inspection failed");
            retainOpenClawStateWorkerErrorPayload(error, result.error);
            return consume({
              error: hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }),
              sourceAdmitted: result.sourceAdmitted,
            });
          }
          return consume({
            value: {
              ok: true,
              sourceAdmitted: true,
              ...result.result,
            },
          });
        }
      }
    }
    if (native && !independentWarmSource) {
      if (isPostgresSqlConnection(native.database.db)) {
        requireNativeDatabaseFile("postgres", "file-snapshot");
      }
      observe?.("owned-snapshot-started");
      prepared = await prepareOwnedStateReadImage(
        native.database.db,
        pathname,
        canReadWarmNativeSourceIndependently(
          native.database,
          pathname,
          context.admission.identity.key,
        )
          ? context.admission.identity
          : undefined,
        authority,
        signal,
      );
    } else if (!snapshot && preserveArtifacts && !independentWarmSource) {
      observe?.("file-snapshot-started");
      const sourceIdentity = { key: context.admission.identity.key };
      if (selection.snapshotPreparation === "awaited" || isSqliteSnapshotReuseActive()) {
        prepared = await prepareSqliteReadOnlyLocationAwaited(pathname, {
          signal,
          expectedSourceIdentity: sourceIdentity,
          reuse: true,
          allowLiveOwner:
            selection.snapshotPreparation === "awaited" &&
            command.type === "plugins.metadata.read" &&
            context.maintenanceScope?.ownsSchemaMaintenance !== true &&
            !getStateDatabaseSchemaLease(pathname),
        });
      } else {
        preparation = startSqliteReadOnlyLocationAsync(pathname, {
          preserveSourceArtifacts: true,
          signal,
          expectedSourceIdentity: sourceIdentity,
          reuse: true,
        });
        const location = await preparation.result;
        prepared = location;
        startSnapshotCleanup = () => location.startCleanup();
      }
    }
    observe?.("snapshot-selection-returned");
    return query(selectedTransport);
  }

  const producer = run();
  return (async () => {
    let value: OpenClawStateReadReply | undefined;
    const errors: unknown[] = [];
    try {
      value = await producer;
      observe?.("producer-returned");
    } catch (error) {
      observe?.("producer-failed");
      errors.push(error);
    }
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
    throwSqliteLifecycleErrors(errors, "Shared-state read and cleanup failed");
    selection.callerSignal?.throwIfAborted();
    observe?.("operation-returned");
    return value;
  })().catch((error: unknown) => {
    throw selection.mapError ? selection.mapError(error, receipt.phase) : error;
  });
}
