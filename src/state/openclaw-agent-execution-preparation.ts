import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkspaceFilesystemEvidence } from "../agents/workspace-state-guard.js";
import type { SessionStoreReadCustody } from "../config/sessions/session-store-read-candidates.js";
import { SqliteWorkerOpenRefusedError } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabaseFileIdentity,
} from "../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  createSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../infra/sqlite-worker-operation-admission.js";
import { currentSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";
import {
  captureAgentDatabaseIntegrityObserver,
  type AgentDatabasePreparedIntegrity,
} from "./agent-database-preparation-context.js";
import type { AgentDeletionWorkerGuard } from "./agent-deletion-worker-contract.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import {
  getOpenClawAgentDatabaseValidationForTransfer,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import {
  publishOpenClawStateDatabaseWorkerAdmission,
  requireOpenClawStateDatabaseIdentity,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

export function readAgentDatabaseRequestPreparation(): {
  readCustody?: readonly SessionStoreReadCustody[];
  workspaceEvidence?: readonly WorkspaceFilesystemEvidence[];
  startupJournal: boolean;
  startupIntegrityRequired: boolean;
  startupCancellation?: Int32Array<SharedArrayBuffer>;
  deletion?: AgentDeletionWorkerGuard;
} {
  const attachment = takeSqliteWorkerOperationAdmissionAttachment();
  if (
    !isRecord(attachment) ||
    attachment.kind !== "agent-execution" ||
    typeof attachment.startupJournal !== "boolean" ||
    typeof attachment.startupIntegrityRequired !== "boolean"
  ) {
    throw new Error("Agent execution requires its request-local preparation facts");
  }
  return {
    // SAFETY: The private admission attachment carries the source owner's typed custody.
    readCustody: attachment.readCustody as readonly SessionStoreReadCustody[] | undefined,
    // SAFETY: The same private binding serializes the workspace owner's captured evidence.
    workspaceEvidence: attachment.workspaceEvidence as
      | readonly WorkspaceFilesystemEvidence[]
      | undefined,
    startupJournal: attachment.startupJournal,
    startupIntegrityRequired: attachment.startupIntegrityRequired,
    // SAFETY: The private host admission owns this Gateway-lifetime cancellation cell.
    startupCancellation: attachment.startupCancellation as
      | Int32Array<SharedArrayBuffer>
      | undefined,
    // SAFETY: The host sends this typed guard; its live owner compares it before SQL.
    deletion: attachment.deletion as AgentDeletionWorkerGuard | undefined,
  };
}

/** Cancellation belongs to Gateway startup, never the first caller of shared preparation. */
export function agentDatabaseStartupInspectionSignal(cancellation: Int32Array): AbortSignal {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new Error("Gateway stopped during agent database inspection"));
  if (Atomics.load(cancellation, 0) !== 0) {
    abort();
  } else {
    void Promise.resolve(Atomics.waitAsync(cancellation, 0, 0).value).then(abort);
  }
  return controller.signal;
}

/** Physical preparation outlives individual waits; registry notifications retain caller context. */
export function createSharedAgentDatabasePreparation(assertCurrent: () => void) {
  const pending = new Set<Promise<void>>();
  let pendingNativeOpen: Promise<void> | undefined;
  const observers = new Set<{
    assertCurrent: () => void;
    notify: (change: AgentDatabaseRegistryChange) => void;
  }>();
  const changes: AgentDatabaseRegistryChange[] = [];
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent() {
      assertCurrent();
      let refused: { error: unknown } | undefined;
      for (const observer of observers) {
        try {
          observer.assertCurrent();
          return;
        } catch (error) {
          refused ??= { error };
        }
      }
      if (refused) {
        throw refused.error;
      }
      throw new AgentDatabaseExecutionAdmissionClosedError(
        "Agent database preparation has no current caller",
      );
    },
    onRegistryChange(change) {
      changes.push(change);
      for (const observer of observers) {
        observer.notify(change);
      }
    },
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Agent database shared opening admission expired");
        }
      }, binding.attachment),
    }),
  };
  return {
    source,
    retain() {
      const preparation = createDeferredCore();
      pending.add(preparation.promise);
      return () => {
        pending.delete(preparation.promise);
        preparation.resolve();
      };
    },
    beginNativeOpen() {
      const opening = createDeferredCore();
      pendingNativeOpen = opening.promise;
      return () => {
        pendingNativeOpen = undefined;
        opening.resolve();
      };
    },
    getPendingNativeOpen: () => pendingNativeOpen,
    getPendingPreparation: () => {
      if (pending.size === 0) {
        return undefined;
      }
      return (async () => {
        while (pending.size > 0) {
          await Promise.all(pending);
        }
      })();
    },
    follow(caller: AgentDatabaseRequestExecutionSource, assertCallerCurrent: () => void) {
      const inCaller = AsyncLocalStorage.snapshot();
      let failure: { error: unknown } | undefined;
      const notify = (change: AgentDatabaseRegistryChange) => {
        try {
          inCaller(() => caller.onRegistryChange?.(change));
        } catch (error) {
          failure = { error };
        }
      };
      for (const change of changes) {
        notify(change);
      }
      const observer = { notify, assertCurrent: () => inCaller(assertCallerCurrent) };
      observers.add(observer);
      return {
        assertPublished() {
          if (failure) {
            throw failure.error;
          }
        },
        release() {
          observers.delete(observer);
        },
      };
    },
  };
}

/** Native generations retain the logical owner's observer, never a request context. */
export function captureAgentDatabasePreparedIntegrity(
  scope: Pick<AgentDatabasePreparedIntegrity, "agentId" | "path" | "env">,
) {
  const observe = captureAgentDatabaseIntegrityObserver();
  return (
    observe &&
    (() => {
      const validation = getOpenClawAgentDatabaseValidationForTransfer(scope);
      if (validation) {
        observe({
          ...scope,
          identity: validation.identity,
          birthtime: validation.birthtime,
          integrityVerifiedAt: validation.integrityVerifiedAt,
        });
      }
    })
  );
}

/** Decode the native lease only after its captured shared-file publication is admitted. */
export function receiveAgentDatabaseSharedOwnerReceipt(
  facts: Record<string, unknown>,
  admission: OpenClawStateDatabaseReadAdmission,
  leaseId: string,
  source: { agentId: string; path: string },
): OpenClawAgentDatabaseWorkerLeaseReceipt {
  const sharedIdentity = facts.identity;
  if (!isRecord(sharedIdentity) || typeof sharedIdentity.canonicalPath !== "string") {
    throw new Error("Agent worker lost its shared-state identity");
  }
  publishOpenClawStateDatabaseWorkerAdmission(admission, {
    ...readDatabaseFileIdentity(sharedIdentity),
    canonicalPath: sharedIdentity.canonicalPath,
  });
  const received = facts.lease;
  if (
    !isRecord(received) ||
    (received.ownerStartTime !== null && typeof received.ownerStartTime !== "number")
  ) {
    throw new Error("Agent worker lease differs from its captured native owner");
  }
  return {
    leaseId,
    agentId: source.agentId,
    path: source.path,
    ownerPid: process.pid,
    ownerStartTime: received.ownerStartTime,
    sharedStatePath: admission.databasePath,
    sharedStateIdentity: admission.identity.key,
  };
}

/** The shared-owner exchange owns its temporary physical fence and transferred port. */
export function prepareAgentDatabaseSharedOwner(
  sharedDatabase: OpenClawStateDatabase,
  lease: {
    receipt: OpenClawAgentDatabaseWorkerLeaseReceipt;
    validation?: OpenClawAgentDatabaseValidation;
    integrityRevoked?: boolean;
  },
): void {
  const sharedIdentity = requireOpenClawStateDatabaseIdentity(sharedDatabase);
  const operation = expectDefined(
    currentSqliteWorkerOperationAdmission.getStore(),
    "Shared-state native admission",
  );
  const previousPhysicalSource = operation.owner.assertPhysicalSourceCurrent;
  const { port1, port2 } = new MessageChannel();
  try {
    operation.owner.assertPhysicalSourceCurrent = () => {
      previousPhysicalSource?.();
      assertExistingDatabaseIdentity(
        sharedDatabase.path,
        sharedIdentity.key,
        sharedIdentity.birthtime,
      );
    };
    requestSqliteWorkerOperationAdmission(
      {
        stage: "prepare",
        facts: {
          kind: "shared-owner",
          identity: sharedIdentity,
          lease: lease.receipt,
          validationPort: port2,
        },
      },
      [port2],
    );
    // The host posts before granting admission; shared revocation remains live after transfer.
    // SAFETY: this private port receives only the host's typed validation receipt.
    const preparation = receiveMessageOnPort(port1)?.message as {
      validation?: OpenClawAgentDatabaseValidation;
      integrityRevoked: boolean;
    };
    lease.validation = preparation.validation;
    lease.integrityRevoked = preparation.integrityRevoked;
  } catch (error) {
    throw new SqliteWorkerOpenRefusedError(error);
  } finally {
    operation.owner.assertPhysicalSourceCurrent = previousPhysicalSource;
    port1.close();
    port2.close();
  }
}
