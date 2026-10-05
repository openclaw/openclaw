import {
  finallyRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  retainOpenClawStateDatabaseForIndependentRead,
} from "./openclaw-state-db-cache.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
} from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { ProfileDisplayRow, UserProfileEmailBinding } from "./user-profiles.types.js";

type SettlementReadCommand = Extract<OpenClawStateReadCommand, { type: "userProfiles.reconcile" }>;
type SettlementRead = {
  bind(
    command: SettlementReadCommand,
    settlement: Promise<SqliteWorkerOperationSettlement>,
    publish: (
      profile: ProfileDisplayRow | undefined,
      bindings?: readonly UserProfileEmailBinding[],
    ) => void,
    release: () => void,
  ): void;
  acknowledge(
    profile: ProfileDisplayRow | undefined,
    bindings?: readonly UserProfileEmailBinding[],
  ): void;
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
  const source = captureOpenClawStateReadSource();
  let borrowed = retainOpenClawStateDatabaseForIndependentRead(pathname);
  const producer = createDeferredCore();
  const controller = new AbortController();
  let active = true;
  let pending = false;
  let selected:
    | {
        command: SettlementReadCommand;
        settlement: Promise<SqliteWorkerOperationSettlement>;
        publish: (
          profile: ProfileDisplayRow | undefined,
          bindings?: readonly UserProfileEmailBinding[],
        ) => void;
        release: () => void;
      }
    | undefined;
  let transport: ReturnType<typeof source.createTransport> | undefined;
  let tail: RetainedOperation<void> | undefined;
  let nativeSettlement: SqliteWorkerOperationSettlement | undefined;
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
  const startRecoveryRead = (read: NonNullable<typeof selected>): RetainedOperation<void> => {
    authority.assertCurrent();
    const readTransport = source.createTransport(read.command);
    transport = readTransport;
    const query = mapRetainedOperation(
      readTransport.startRead(
        {
          context,
          location: pathname,
          checkFreshAdmission: false,
          expectedIdentity: identity.key,
        },
        authority,
      ),
      (outcome) => {
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.value;
      },
    );
    const released = finallyRetainedOperation(
      query,
      () =>
        mapRetainedOperation(readTransport.startClose(), () => {
          transport = undefined;
        }),
      (readError, cleanupError) =>
        createSqliteLifecycleAggregateError(
          [readError, cleanupError],
          "Shared-state settlement read and cleanup failed",
          readError,
        ),
    );
    return mapRetainedOperation(released, (reply) => {
      authority.assertCurrent();
      if (reply.type !== "userProfiles.reconcile") {
        throw new Error("Unexpected shared-state settlement read reply");
      }
      read.publish(reply.profile, reply.emailBindings);
      pending = false;
    });
  };
  const recover = (): Promise<void> =>
    (recovery ??= (async () => {
      if (!pending || !selected) {
        return;
      }
      // Only the actual mutation producer supplies this fact. The wait stays asynchronous.
      nativeSettlement ??= await selected.settlement;
      if (nativeSettlement.kind === "not-entered") {
        pending = false;
        return;
      }
      const read = selected;
      // A failed transport's retirement is sticky; join it before creating a retry.
      tail = transport
        ? flatMapRetainedOperation(transport.startClose(), () => {
            transport = undefined;
            return startRecoveryRead(read);
          })
        : startRecoveryRead(read);
      await tail.result;
    })().finally(() => {
      tail = undefined;
      recovery = undefined;
    }));
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      // Producer completion is distinct from cleanup, including pre-dispatch refusal.
      await producer.promise;
      await recover();
      if (transport) {
        tail = mapRetainedOperation(transport.startClose(), () => {
          transport = undefined;
        });
        await tail.result;
        tail = undefined;
      }
      borrowed?.release();
      borrowed = undefined;
      selected?.release();
      active = false;
      unregister();
      releaseSource();
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
  const releaseSource = source.own(() => tail?.service(), close);
  context.maintenanceScope?.own(producer, "shared-resources", close);
  const errors: unknown[] = [];
  let result!: T;
  try {
    result = await operation({
      bind(command, settlement, publish, release) {
        if (selected || !active) {
          throw new Error("Shared-state settlement read was already bound");
        }
        authority.assertCurrent();
        selected = { command: { ...command }, settlement, publish, release };
        pending = true;
      },
      acknowledge(profile, bindings) {
        authority.assertCurrent();
        if (selected) {
          if (!profile || profile.id !== selected.command.profileId) {
            throw new Error("Profile commit differs from its retained settlement read");
          }
          selected.publish(profile, bindings);
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
