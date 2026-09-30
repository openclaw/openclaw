import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { RetainedOperation, RetainedOutcome } from "../infra/retained-operation.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { retainSnapshotTempDirectory } from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationFromOwnedDatabase } from "../infra/sqlite-readonly-location.js";
import type {
  AsyncPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
} from "../infra/sqlite-readonly-location.types.js";
import { startSqliteReadOnlyLocationAsync } from "../infra/sqlite-snapshot-source.js";
import {
  assertExistingDatabaseIdentity,
  type DatabaseFileIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  borrowOpenClawStateDatabaseForAsyncRead,
  retainOpenClawStateDatabaseForIndependentRead,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { canReadWarmNativeSourceIndependently } from "./openclaw-state-db-readonly-reuse.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";
import { observeReadOutcome, type OpenClawStateReadReceipt } from "./openclaw-state-read-error.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
  OpenClawStateReadOptions,
  OpenClawStateReadReply,
  ReadResource,
  RetainedReadScope,
} from "./openclaw-state-read.types.js";
import type { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";

type ReadResult = OpenClawStateReadReply | undefined;
export type OpenClawStateReadCompletion =
  | { kind: "retained"; operation: RetainedOperation<ReadResult> }
  | { kind: "awaited-only"; result: Promise<ReadResult> };

type Selection = {
  pathname: string;
  snapshot?: {
    location: string;
    cleanupRoot?: string;
    assertCurrent?(): void;
    release?(): void;
  };
  scopes: RetainedReadScope[];
  context: ReturnType<typeof captureOpenClawStateReadWorkerContext>;
  preserveArtifacts: boolean;
  preferIndependentWarmRead?: true;
  controller: AbortController;
  signal: AbortSignal;
  receipt: OpenClawStateReadReceipt;
  mapError: OpenClawStateReadOptions["mapError"];
};

/** Owns query admission and release together, so a later reader can release an earlier slot. */
export function startOpenClawStateReadOperation(
  command: OpenClawStateReadCommand,
  selection: Selection,
): OpenClawStateReadCompletion {
  const {
    pathname,
    snapshot,
    scopes,
    context,
    preserveArtifacts,
    preferIndependentWarmRead,
    controller,
    signal,
    receipt,
  } = selection;
  const resume = AsyncLocalStorage.snapshot();
  const result = createDeferredCore<ReadResult>();
  void result.promise.catch(() => undefined);
  let outcome: RetainedOutcome<ReadResult> = { status: "pending" };
  let source: ReturnType<typeof captureOpenClawStateReadSource> | undefined;
  let transport:
    | ReturnType<ReturnType<typeof captureOpenClawStateReadSource>["createTransport"]>
    | undefined;
  let unregisterSource: (() => void) | undefined;
  let unregister: (() => void) | undefined;
  let borrowed: ReturnType<typeof retainOpenClawStateDatabaseForIndependentRead>;
  let prepared: AsyncPreparedSqliteReadOnlyLocation | undefined;
  let preparation: RetainedSqliteSnapshotPreparation | undefined;
  let preparationClose: RetainedOperation<void> | undefined;
  let startPreparedCleanup: (() => RetainedOperation<boolean>) | undefined;
  let releasePreparedSource: (() => void) | undefined;
  let expectedIdentity: string | undefined;
  let expectedSourceIdentity: DatabaseFileIdentity | undefined;
  let awaitedOnly = false;
  let producerSettled = false;
  let value: ReadResult;
  const errors: unknown[] = [];
  const acceptanceErrors: unknown[] = [];
  let producerStep: (() => boolean) | undefined;
  let cleanupStep: (() => boolean) | undefined;
  let cleanupAttempt: ReturnType<typeof createDeferredCore<void>> | undefined;
  let transportStopped = false;
  let cleaned = false;
  let validated = false;
  let servicing = false;

  const assertReadLifetime = () => {
    signal.throwIfAborted();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    snapshot?.assertCurrent?.();
    borrowed?.assertCurrent();
    if (expectedIdentity !== undefined) {
      assertExistingDatabaseIdentity(pathname, expectedIdentity);
    }
    if (expectedSourceIdentity) {
      assertExistingDatabaseIdentity(
        pathname,
        expectedSourceIdentity.key,
        expectedSourceIdentity.birthtime,
      );
    }
    if (scopes.some((scope) => !scope.active)) {
      throw new Error("Shared-state read scope is closed");
    }
  };
  const authority: OpenClawStateReadAuthority = {
    signal,
    assertCurrent() {
      assertReadLifetime();
      openClawStateDatabaseCache.assertOpenClawStateDatabaseOpenAllowed(pathname, "cached-read");
    },
  };

  function settle(cleanupErrors: unknown[] = []) {
    if (outcome.status !== "pending") {
      return;
    }
    try {
      throwSqliteLifecycleErrors(
        [
          ...errors,
          ...[...new Set(acceptanceErrors)].filter((error) => !errors.includes(error)),
          ...cleanupErrors,
        ],
        "Shared-state read and cleanup failed",
      );
      outcome = { status: "fulfilled", value };
      result.resolve(value);
    } catch (error) {
      let mapped: unknown;
      try {
        mapped = selection.mapError ? selection.mapError(error, receipt.phase) : error;
      } catch (mappingError) {
        mapped = mappingError;
      }
      outcome = { status: "rejected", error: mapped };
      result.reject(mapped);
    }
  }

  function finishCleanup(error?: { error: unknown }) {
    const attempt = cleanupAttempt;
    cleanupAttempt = undefined;
    cleanupStep = undefined;
    if (error) {
      attempt?.reject(error.error);
    } else {
      attempt?.resolve();
    }
    if (producerSettled) {
      settle(error ? [error.error] : []);
    }
  }

  function release() {
    if (!validated) {
      validated = true;
      try {
        authority.assertCurrent();
      } catch (error) {
        acceptanceErrors.push(error);
      }
    }
    borrowed?.release();
    borrowed = undefined;
    snapshot?.release?.();
    cleaned = true;
    unregister?.();
    for (const scope of scopes) {
      scope.resources.delete(resource);
    }
    unregisterSource?.();
    finishCleanup();
  }

  function acceptCleanup(success: boolean) {
    if (!success) {
      throw new Error(
        `Shared-state read snapshot cleanup failed: ${prepared?.cleanupRoot ?? pathname}`,
      );
    }
    prepared = undefined;
    startPreparedCleanup = undefined;
    closePreparation();
  }

  function startPreparationClose(): RetainedOperation<void> | undefined {
    if (!preparation) {
      return undefined;
    }
    if (!preparationClose || preparationClose.read().status === "rejected") {
      preparationClose = preparation.startClose();
      void preparationClose.result.then(service, service);
    }
    return preparationClose;
  }

  function closePreparation() {
    const closing = startPreparationClose();
    if (!closing) {
      release();
      return;
    }
    waitRetained("cleanup", closing, () => {
      preparation = undefined;
      preparationClose = undefined;
      release();
    });
  }

  function cleanupPrepared() {
    if (!prepared) {
      closePreparation();
      return;
    }
    releasePreparedSource?.();
    if (startPreparedCleanup) {
      waitRetained("cleanup", startPreparedCleanup(), acceptCleanup);
    } else {
      // Native backup cleanup is genuinely awaited; only its query/transport tail is serviceable.
      const pending = prepared.cleanupAsync();
      cleanupStep = undefined;
      void pending.then(
        (success) =>
          resume(() => {
            try {
              acceptCleanup(success);
            } catch (error) {
              finishCleanup({ error });
            }
            service();
          }),
        (error: unknown) =>
          resume(() => {
            finishCleanup({ error });
            service();
          }),
      );
    }
  }

  function waitProducer() {
    cleanupStep = () => {
      if (!producerSettled) {
        if (signal.aborted) {
          const closing = startPreparationClose();
          closing?.service();
          const joined = closing?.read();
          if (joined?.status === "rejected") {
            throw joined.error;
          }
        }
        return false;
      }
      cleanupStep = undefined;
      cleanupPrepared();
      return true;
    };
  }

  function cleanup(): Promise<void> {
    if (cleaned) {
      return Promise.resolve();
    }
    if (cleanupAttempt) {
      return cleanupAttempt.promise;
    }
    const attempt = createDeferredCore();
    void attempt.promise.catch(() => undefined);
    cleanupAttempt = attempt;
    try {
      if (!transportStopped && transport) {
        // Stop the transport before joining its producer; failed stops retain custody for retry.
        waitRetained("cleanup", transport.startClose(), () => {
          transportStopped = true;
          waitProducer();
        });
      } else {
        waitProducer();
      }
    } catch (error) {
      finishCleanup({ error });
    }
    service();
    return attempt.promise;
  }

  function finishProducer(error?: { error: unknown }) {
    producerStep = undefined;
    producerSettled = true;
    if (error) {
      errors.push(error.error);
    }
    void cleanup();
  }

  function service() {
    if (servicing) {
      return;
    }
    servicing = true;
    try {
      resume(() => {
        let changed: boolean;
        do {
          try {
            changed = producerStep?.() ?? false;
          } catch (error) {
            finishProducer({ error });
            changed = true;
          }
          try {
            changed = (cleanupStep?.() ?? false) || changed;
          } catch (error) {
            finishCleanup({ error });
            changed = true;
          }
        } while (changed);
      });
    } finally {
      servicing = false;
    }
  }

  function waitRetained<T>(
    lane: "producer" | "cleanup",
    operation: RetainedOperation<T>,
    accept: (value: T) => void,
  ) {
    const step = () => {
      operation.service();
      const next = operation.read();
      if (next.status === "pending") {
        return false;
      }
      if (lane === "producer") {
        producerStep = undefined;
      } else {
        cleanupStep = undefined;
      }
      if (next.status === "rejected") {
        throw next.error;
      }
      accept(next.value);
      return true;
    };
    if (lane === "producer") {
      producerStep = step;
    } else {
      cleanupStep = step;
    }
    void operation.result.then(service, service);
  }

  function query() {
    if (!snapshot && !prepared) {
      expectedIdentity = context.admission.identity.key;
    }
    if (prepared) {
      authority.assertCurrent();
      releasePreparedSource = retainSnapshotTempDirectory(
        prepared.cleanupRoot ?? path.dirname(prepared.location),
      );
    }
    // The transport checks current authority at dispatch, including after a queue wait.
    receipt.phase = "unobserved";
    if (!transport) {
      throw new Error("Shared-state read transport is unavailable");
    }
    waitRetained(
      "producer",
      transport.startRead(
        {
          context,
          location: prepared?.location ?? snapshot?.location ?? pathname,
          checkFreshAdmission: !borrowed,
          expectedIdentity,
          snapshotRoot: prepared?.cleanupRoot ?? snapshot?.cleanupRoot,
        },
        authority,
      ),
      (readOutcome) => {
        observeReadOutcome(receipt, readOutcome);
        const admitted =
          "error" in readOutcome
            ? readOutcome.sourceAdmitted
            : readOutcome.value.type !== "admit" && readOutcome.value.sourceAdmitted;
        try {
          authority.assertCurrent();
          if (admitted) {
            borrowed?.observe();
          }
        } catch (error) {
          if (!("error" in readOutcome)) {
            throw error;
          }
          acceptanceErrors.push(error);
        }
        if ("error" in readOutcome) {
          throw readOutcome.error;
        }
        value = readOutcome.value;
        finishProducer();
      },
    );
  }

  const resource: ReadResource = {
    close() {
      controller.abort(new Error("Shared-state read admission closed"));
      return resume(cleanup);
    },
  };

  try {
    source = captureOpenClawStateReadSource();
    transport = source.createTransport(command);
    unregister = registerOpenClawStateDatabaseAsyncResource({
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
    unregisterSource = source.own(service, () => resource.close());
    assertReadLifetime();
    if (snapshot) {
      openClawStateDatabaseCache.assertOpenClawStateDatabaseOpenAllowed(pathname, "cached-read");
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
      preferIndependentWarmRead &&
      canReadWarmNativeSourceIndependently(
        native.database,
        pathname,
        context.admission.identity.key,
      );
    if (!snapshot && !borrowed && !existingPathOrUndefined(pathname)) {
      finishProducer();
    } else if (native && !independentWarmSource) {
      awaitedOnly = true;
      void prepareSqliteReadOnlyLocationFromOwnedDatabase(
        native.database.db,
        authority.assertCurrent,
        authority.signal,
        "async",
      ).then(
        (location) =>
          resume(() => {
            try {
              prepared = location;
              query();
            } catch (error) {
              finishProducer({ error });
            }
            service();
          }),
        (error: unknown) =>
          resume(() => {
            finishProducer({ error });
            service();
          }),
      );
    } else if (!snapshot && preserveArtifacts && !independentWarmSource) {
      expectedSourceIdentity = { key: context.admission.identity.key };
      authority.assertCurrent();
      waitRetained("producer", transport.startValidateFresh(context, authority), () => {
        authority.assertCurrent();
        preparation = startSqliteReadOnlyLocationAsync(pathname, {
          preserveSourceArtifacts: preserveArtifacts,
          signal: authority.signal,
          expectedSourceIdentity,
        });
        waitRetained("producer", preparation, (location) => {
          prepared = location;
          startPreparedCleanup = () => location.startCleanup();
          query();
        });
      });
    } else {
      query();
    }
  } catch (error) {
    finishProducer({ error });
  }
  service();
  return awaitedOnly
    ? { kind: "awaited-only", result: result.promise }
    : {
        kind: "retained",
        operation: {
          result: result.promise,
          read: () => outcome,
          service() {
            source?.service();
            service();
          },
        },
      };
}
