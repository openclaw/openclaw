import { throwSqliteLifecycleErrors } from "../infra/sqlite-coordinator.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import {
  acquireStateDatabaseHandleLease,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  retainOpenClawStateDatabaseForIndependentRead,
} from "./openclaw-state-db-cache.js";
import { createOpenClawStateReadTransport } from "./openclaw-state-read-worker.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
  OpenClawStateReadOutcome,
} from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { retainUserProfilePublication } from "./user-profile-list.js";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

type SettlementReadCommand = Extract<OpenClawStateReadCommand, { type: "userProfiles.reconcile" }>;
type SettlementPublication = ReturnType<typeof retainUserProfilePublication> & {
  onUncertain?: () => void;
};
type SettlementRead = {
  bind(
    command: SettlementReadCommand,
    settlement: Promise<SqliteWorkerOperationSettlement>,
    publication: SettlementPublication,
  ): void;
  acknowledge(profile: ProfileDisplayRow | undefined): void;
};

/** A fixed read completes an accepted mutation; it grants no new write or path admission. */
export async function withOpenClawStateSettlementRead<T>(
  context: OpenClawStateWorkerContext,
  operation: (read: SettlementRead) => Promise<T>,
): Promise<T> {
  context.admission.assertCurrent();
  context.maintenanceScope?.assertAdmission();
  const pathname = context.admission.databasePath;
  const identity = { ...context.admission.identity };
  let borrowed = retainOpenClawStateDatabaseForIndependentRead(pathname);
  let pin = borrowed
    ? undefined
    : withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
        acquireStateDatabaseHandleLease({ databasePath: pathname }),
      );
  const producer = createDeferredCore();
  const controller = new AbortController();
  let active = true;
  let pending = false;
  let selected:
    | {
        command: SettlementReadCommand;
        settlement: Promise<SqliteWorkerOperationSettlement>;
        publication: SettlementPublication;
      }
    | undefined;
  let transport: ReturnType<typeof createOpenClawStateReadTransport> | undefined;
  let recovery: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const authority: OpenClawStateReadAuthority = {
    signal: controller.signal,
    assertCurrent() {
      if (!active) {
        throw new Error("Shared-state settlement read has released its owner");
      }
      borrowed?.assertCurrent();
      assertExistingDatabaseIdentity(pathname, identity.key);
    },
  };
  const recover = (): Promise<void> =>
    (recovery ??= (async () => {
      if (!pending || !selected) {
        return;
      }
      const settled = await selected.settlement;
      if (settled.kind === "not-entered") {
        pending = false;
        return;
      }
      // Accepted access changes cannot wait for source validation or projection recovery.
      const onUncertain = selected.publication.onUncertain;
      selected.publication.onUncertain = undefined;
      onUncertain?.();
      for (;;) {
        // A failed transport's retirement is sticky; join it before creating a retry.
        if (transport) {
          await transport.close();
          transport = undefined;
        }
        authority.assertCurrent();
        const prepared = await selected.publication.prepareRecoveryRead();
        authority.assertCurrent();
        const readTransport = createOpenClawStateReadTransport(selected.command, () => {});
        transport = readTransport;
        let result: OpenClawStateReadOutcome | undefined;
        const errors: unknown[] = [];
        try {
          result = await readTransport.read(
            {
              context,
              location: pathname,
              checkFreshAdmission: false,
              expectedIdentity: identity.key,
            },
            authority,
          );
          if ("error" in result) {
            errors.push(result.error);
          }
        } catch (error) {
          errors.push(error);
        }
        try {
          await readTransport.close();
          transport = undefined;
        } catch (error) {
          errors.push(error);
        }
        const taskFailure = await readTransport.readFailure();
        if (taskFailure && !errors.includes(taskFailure.error)) {
          errors.unshift(taskFailure.error);
        }
        throwSqliteLifecycleErrors(errors, "Shared-state settlement read and cleanup failed");
        authority.assertCurrent();
        if (!result || "error" in result || result.value.type !== "userProfiles.reconcile") {
          throw new Error("Unexpected shared-state settlement read reply");
        }
        if (!prepared.publish(result.value.profile)) {
          continue;
        }
        pending = false;
        return;
      }
    })().finally(() => {
      recovery = undefined;
    }));
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      // Producer completion is distinct from cleanup, including pre-dispatch refusal.
      await producer.promise;
      await recover();
      if (transport) {
        await transport.close();
        transport = undefined;
      }
      borrowed?.release();
      borrowed = undefined;
      pin?.release();
      pin = undefined;
      selected?.publication.release();
      active = false;
      unregister();
    })().finally(() => {
      closing = undefined;
    }));
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(target) {
      if (
        !target ||
        target.key === identity.key ||
        target.canonicalPath === identity.canonicalPath
      ) {
        await close();
      }
    },
  });
  context.maintenanceScope?.own(producer, "shared-resources", close);
  const errors: unknown[] = [];
  let result!: T;
  try {
    result = await operation({
      bind(command, settlement, publication) {
        if (selected || !active) {
          throw new Error("Shared-state settlement read was already bound");
        }
        authority.assertCurrent();
        selected = { command: { ...command }, settlement, publication: { ...publication } };
        pending = true;
      },
      acknowledge(profile) {
        authority.assertCurrent();
        if (selected) {
          if (!profile || profile.id !== selected.command.profileId) {
            throw new Error("Profile commit differs from its retained settlement read");
          }
          selected.publication.publishCommitted(profile);
        } else if (profile) {
          throw new Error("Profile commit did not retain its catalog publication");
        }
        pending = false;
      },
    });
  } catch (error) {
    errors.push(error);
  }
  let recovered = false;
  try {
    await recover();
    recovered = true;
  } catch (error) {
    errors.push(error);
  } finally {
    producer.resolve();
  }
  if (recovered) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "Shared-state mutation and settlement read failed");
  return result;
}
