import path from "node:path";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { requireNativeDatabaseFile } from "../infra/database-engine/physical-facts.js";
import { getStateDatabaseSchemaLease } from "../infra/gateway-state-owner.js";
import { resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
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
  prepareSqliteReadOnlyLocationAwaited,
  startSqliteReadOnlyLocationAsync,
} from "../infra/sqlite-snapshot-source.js";
import {
  borrowOpenClawStateDatabaseForAsyncRead,
  retainOpenClawStateDatabaseForIndependentRead,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { canReadWarmNativeSourceIndependently } from "./openclaw-state-db-readonly-reuse.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";
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

type Selection = {
  pathname: string;
  snapshot?: {
    postgresSnapshot?: string;
    location: string;
    cleanClose?: boolean;
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
  let cleaned = false;
  const authority: OpenClawStateReadAuthority = {
    signal,
    assertCurrent() {
      signal.throwIfAborted();
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      openClawStateDatabaseCache.assertOpenClawStateDatabaseOpenAllowed(pathname, "cached-read");
    },
  };

  const closeTransport = async () => {
    if (!transport) {
      return;
    }
    retirement ??= transport.startClose();
    try {
      await retirement;
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
      await closeTransport();
      releasePreparedSource?.();
      releasePreparedSource = undefined;
      if (prepared) {
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
      }
      if (preparation) {
        preparationClose ??= preparation.startClose();
        try {
          await preparationClose.result;
        } catch (error) {
          preparationClose = undefined;
          throw error;
        }
        preparation = undefined;
        preparationClose = undefined;
      }
      borrowed?.release();
      await snapshot?.release?.();
      cleaned = true;
      unregister();
      unregisterSource?.();
      for (const scope of scopes) {
        scope.resources.delete(resource);
      }
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
        location: snapshot?.cleanClose
          ? resolveImmutableSqliteFileUri(snapshot.location)
          : (prepared?.location ?? snapshot?.location ?? pathname),
        checkFreshAdmission: !borrowed,
        expectedIdentity:
          (!snapshot && !prepared) || snapshot?.cleanClose || snapshot?.postgresSnapshot
            ? context.admission.identity.key
            : undefined,
        snapshotRoot: prepared?.cleanupRoot ?? snapshot?.cleanupRoot,
        postgresSnapshot: snapshot?.postgresSnapshot,
      },
      authority,
    );
    return consume(await read);
  }

  async function run(): OpenClawStateReadCompletion {
    const source = captureOpenClawStateReadSource();
    const selectedTransport = source.createTransport(
      command,
      selection.onChunk,
      selection.onChunkAsync,
      selection.snapshotPreparation === "awaited",
    );
    transport = selectedTransport;
    unregisterSource = source.own(() => resource.close());
    if (command.type === "admit") {
      return query(selectedTransport);
    }
    const native =
      !snapshot && preserveArtifacts
        ? borrowOpenClawStateDatabaseForAsyncRead(pathname, "cached-read")
        : undefined;
    borrowed =
      native ??
      (!snapshot && !preserveArtifacts
        ? retainOpenClawStateDatabaseForIndependentRead(pathname, "cached-read")
        : undefined);
    const independentWarmSource =
      native &&
      selection.preferIndependentWarmRead &&
      canReadWarmNativeSourceIndependently(
        native.database,
        pathname,
        context.admission.identity.key,
      );
    if (!snapshot && !borrowed && !existingPathOrUndefined(pathname)) {
      return undefined;
    }
    if (native && !independentWarmSource) {
      if (isPostgresSqlConnection(native.database.db)) {
        requireNativeDatabaseFile("postgres", "file-snapshot");
      }
      prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(
        native.database.db,
        authority.assertCurrent,
        signal,
        "async",
      );
    } else if (!snapshot && preserveArtifacts && !independentWarmSource) {
      const sourceIdentity = { key: context.admission.identity.key };
      const validation = selectedTransport.startValidateFresh(context, authority);
      await validation;
      if (
        (command.type === "plugins.metadata.read" || command.type === "config.health.read") &&
        !context.existingSchemaPath &&
        !context.maintenanceScope &&
        !getStateDatabaseSchemaLease(pathname) &&
        (hasVerifiedLiveSqliteOwner(pathname) || readSqliteDatabaseCleanClose(pathname))
      ) {
        // Read startup metadata in the child's pinned transaction instead of
        // copying unrelated state. Sealed files retain custody in that child;
        // unclean and retained snapshots keep their private recovery owner.
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
      if (selection.snapshotPreparation === "awaited") {
        prepared = await prepareSqliteReadOnlyLocationAwaited(pathname, {
          signal,
          expectedSourceIdentity: sourceIdentity,
          allowLiveOwner:
            command.type === "plugins.metadata.read" &&
            context.maintenanceScope?.ownsSchemaMaintenance !== true &&
            !getStateDatabaseSchemaLease(pathname),
        });
      } else {
        preparation = startSqliteReadOnlyLocationAsync(pathname, {
          preserveSourceArtifacts: true,
          signal,
          expectedSourceIdentity: sourceIdentity,
        });
        const location = await preparation.result;
        prepared = location;
        startSnapshotCleanup = () => location.startCleanup();
      }
    }
    return query(selectedTransport);
  }

  const producer = run();
  return (async () => {
    let value: OpenClawStateReadReply | undefined;
    const errors: unknown[] = [];
    try {
      value = await producer;
    } catch (error) {
      errors.push(error);
    }
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
    throwSqliteLifecycleErrors(errors, "Shared-state read and cleanup failed");
    selection.callerSignal?.throwIfAborted();
    return value;
  })().catch((error: unknown) => {
    throw selection.mapError ? selection.mapError(error, receipt.phase) : error;
  });
}
