import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import type { WorkerCredentialRecord } from "./credential.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerEnvironmentAttachmentRecord } from "./session-attachment.js";
import { isTerminalWorkerEnvironmentState } from "./state.js";
import {
  digestWorkerEnvironmentAttachmentAuthority,
  digestWorkerEnvironmentAuthority,
  digestWorkerCredentialAuthority,
  encodeWorkerEnvironmentTransferAuthority,
} from "./store-commit-authority.js";
import { WorkerEnvironmentInventoryClosedError } from "./store-errors.js";
import { assertShape } from "./store-validation.js";
import type { WorkerEnvironmentCommitAdmission, WorkerEnvironmentFacts } from "./store.types.js";

export type WorkerEnvironmentNativePatch = Partial<
  Pick<
    WorkerEnvironmentRecord,
    "nodeDeviceId" | "updatedAtMs" | "preparation" | "lastActivatedAtMs"
  >
>;
type NativeField<T> = { revision: number; value: T };
type NativeOverlay = {
  [Field in keyof WorkerEnvironmentNativePatch]?: NativeField<WorkerEnvironmentRecord[Field]>;
};
const nativeFields = ["nodeDeviceId", "updatedAtMs", "preparation", "lastActivatedAtMs"] as const;
function nativeField<T>(
  previous: NativeField<T> | undefined,
  value: T | undefined,
  revision: number,
) {
  return value !== undefined && revision > (previous?.revision ?? -1)
    ? { revision, value }
    : previous;
}
function applyNativeOverlay(
  row: WorkerEnvironmentRecord,
  overlay: NativeOverlay,
): WorkerEnvironmentRecord {
  return freezeJsonSnapshot({
    ...row,
    ...(overlay.nodeDeviceId ? { nodeDeviceId: overlay.nodeDeviceId.value } : {}),
    ...(overlay.updatedAtMs ? { updatedAtMs: overlay.updatedAtMs.value } : {}),
    ...(overlay.preparation ? { preparation: overlay.preparation.value } : {}),
    ...(overlay.lastActivatedAtMs ? { lastActivatedAtMs: overlay.lastActivatedAtMs.value } : {}),
  });
}

const ownAdmission = new AsyncLocalStorage<object>();
function createWorkerEnvironmentProjection() {
  const environments = new Map<string, WorkerEnvironmentRecord>();
  const credentials = new Map<string, WorkerCredentialRecord>();
  const attachments = new Map<string, WorkerEnvironmentAttachmentRecord>();
  const attachmentAuthorities = new Map<string, string>();
  const revisions = new Map<string, number>();
  const nativeOverlays = new Map<string, NativeOverlay>();
  const pending = new Map<
    string,
    {
      token: object;
      environmentAuthorityUnchanged: boolean;
      credentialAuthorityUnchanged: boolean;
      transferAuthorityUnchanged: boolean;
      attachmentAuthorityUnchanged: boolean;
    }
  >();
  const reconciliations = new Map<
    object,
    { ids: string[]; error: unknown; revocationId?: string }
  >();
  const revocationListeners = new Set<(environmentId: string) => void>();
  let sequence = 0;
  let version = 0;
  let active = true;
  let references = 0;
  let tail = Promise.resolve();
  let sorted: WorkerEnvironmentRecord[] | undefined;
  let reconcilable: WorkerEnvironmentRecord[] | undefined;
  const assertActive = () => {
    if (!active) {
      throw new WorkerEnvironmentInventoryClosedError();
    }
  };
  const assertReadable = (
    id: string,
    authority: "environment" | "credential" | "transfer" | "attachment",
  ) => {
    assertActive();
    const mutation = pending.get(id);
    const unchanged = mutation?.[`${authority}AuthorityUnchanged`];
    if (mutation && mutation.token !== ownAdmission.getStore() && !unchanged) {
      throw new Error(
        `Worker environment ${id} has an unsettled mutation; retry after it completes`,
      );
    }
  };
  const compare = (a: WorkerEnvironmentRecord, b: WorkerEnvironmentRecord) =>
    a.createdAtMs - b.createdAtMs ||
    Buffer.compare(Buffer.from(a.environmentId), Buffer.from(b.environmentId));
  const close = () => {
    active = false;
    environments.clear();
    credentials.clear();
    attachments.clear();
    attachmentAuthorities.clear();
    revisions.clear();
    nativeOverlays.clear();
    pending.clear();
    reconciliations.clear();
    revocationListeners.clear();
    sorted = undefined;
    reconcilable = undefined;
  };
  return {
    incarnation: randomUUID(),
    get active() {
      return active;
    },
    version: () => version,
    retain() {
      assertActive();
      references += 1;
      let released = false;
      return () => {
        if (released) {
          return false;
        }
        released = true;
        references -= 1;
        if (references !== 0) {
          return false;
        }
        close();
        return true;
      };
    },
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      assertActive();
      const result = tail.then(operation);
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    async ready() {
      for (;;) {
        const current = tail;
        await current;
        assertActive();
        if (current === tail) {
          return;
        }
      }
    },
    nextSequence: () => ++sequence,
    withAdmission<T>(token: object, callback: () => T): T {
      return ownAdmission.run(token, callback);
    },
    fence(facts: WorkerEnvironmentCommitAdmission, token: object) {
      assertActive();
      for (const {
        environmentId,
        environmentAuthority,
        credentialAuthority,
        transferAuthority,
        attachmentAuthority,
      } of facts) {
        const previous = pending.get(environmentId);
        if (previous && previous.token !== token) {
          throw new Error("Worker inventory mutation ordering was lost");
        }
        pending.set(environmentId, {
          token,
          attachmentAuthorityUnchanged:
            attachmentAuthority ===
            (attachmentAuthorities.get(environmentId) ??
              digestWorkerEnvironmentAttachmentAuthority(undefined)),
          environmentAuthorityUnchanged:
            environmentAuthority ===
            digestWorkerEnvironmentAuthority(environments.get(environmentId)),
          credentialAuthorityUnchanged:
            credentialAuthority === digestWorkerCredentialAuthority(credentials.get(environmentId)),
          transferAuthorityUnchanged:
            transferAuthority ===
            encodeWorkerEnvironmentTransferAuthority(
              environments.get(environmentId),
              credentials.get(environmentId),
            ),
        });
      }
    },
    retainReconciliation(
      token: object,
      ids: readonly string[],
      error: unknown,
      revocationId?: string,
    ) {
      assertActive();
      reconciliations.set(token, { ids: [...ids], error, revocationId });
    },
    pendingReconciliations() {
      assertActive();
      return [...reconciliations].map(([token, recovery]) => Object.assign({ token }, recovery));
    },
    hasPendingReconciliation: () => reconciliations.size !== 0,
    release(token: object) {
      for (const [id, value] of pending) {
        if (value.token === token) {
          pending.delete(id);
        }
      }
      reconciliations.delete(token);
    },
    onCredentialRevoked(listener: (environmentId: string) => void) {
      assertActive();
      return registerListener(revocationListeners, (environmentId) => listener(environmentId));
    },
    publishCredentialRevoked(environmentId: string) {
      assertActive();
      const failures: unknown[] = [];
      notifyListeners(revocationListeners, environmentId, (error) => failures.push(error));
      if (failures.length) {
        throw new AggregateError(failures, "Worker environment revocation publication failed");
      }
    },
    install(facts: WorkerEnvironmentFacts, revision: number, notify = true) {
      assertActive();
      // Worker replies already own their rows; freeze each published revision for shared reads.
      const changed = new Set(facts.ids.filter((id) => revision >= (revisions.get(id) ?? -1)));
      const retainedSessions = new Set(
        facts.attachments
          .filter((row) => changed.has(row.environmentId))
          .map((row) => row.sessionId),
      );
      for (const id of changed) {
        environments.delete(id);
        credentials.delete(id);
        attachmentAuthorities.delete(id);
        revisions.set(id, revision);
      }
      for (const [session, attachment] of attachments) {
        if (changed.has(attachment.environmentId) && !retainedSessions.has(session)) {
          attachments.delete(session);
        }
      }
      for (const row of facts.environments) {
        if (changed.has(row.environmentId)) {
          const overlay = nativeOverlays.get(row.environmentId);
          if (overlay) {
            for (const field of nativeFields) {
              if ((overlay[field]?.revision ?? -1) <= revision) {
                delete overlay[field];
              }
            }
            if (!nativeFields.some((field) => overlay[field])) {
              nativeOverlays.delete(row.environmentId);
            }
          }
          environments.set(
            row.environmentId,
            overlay ? applyNativeOverlay(row, overlay) : freezeJsonSnapshot(row),
          );
        }
      }
      for (const id of changed) {
        if (!environments.has(id)) {
          nativeOverlays.delete(id);
        }
      }
      for (const row of facts.credentials) {
        if (changed.has(row.environmentId)) {
          credentials.set(row.environmentId, Object.freeze(row));
        }
      }
      for (const row of facts.attachments) {
        if (changed.has(row.environmentId)) {
          attachments.set(row.sessionId, Object.freeze(row));
          attachmentAuthorities.set(
            row.environmentId,
            digestWorkerEnvironmentAttachmentAuthority(row),
          );
        }
      }
      if (changed.size) {
        version += 1;
        sorted = undefined;
        reconcilable = undefined;
        if (notify) {
          sessionChanges.emit({ all: true, scope: "worker-environments" });
        }
      }
    },
    publishPatch(id: string, patch: WorkerEnvironmentNativePatch, revision: number) {
      assertActive();
      if (revision <= (revisions.get(id) ?? -1)) {
        return;
      }
      const captured = freezeJsonSnapshot(structuredClone(patch));
      const previous = nativeOverlays.get(id);
      const overlay: NativeOverlay = {
        nodeDeviceId: nativeField(previous?.nodeDeviceId, captured.nodeDeviceId, revision),
        updatedAtMs: nativeField(previous?.updatedAtMs, captured.updatedAtMs, revision),
        preparation: nativeField(previous?.preparation, captured.preparation, revision),
        lastActivatedAtMs: nativeField(
          previous?.lastActivatedAtMs,
          captured.lastActivatedAtMs,
          revision,
        ),
      };
      nativeOverlays.set(id, overlay);
      const row = environments.get(id);
      if (row) {
        environments.set(id, applyNativeOverlay(row, overlay));
      }
      version += 1;
      sorted = undefined;
      reconcilable = undefined;
    },
    preparedRecords() {
      assertActive();
      return [...environments.values()].filter((row) => row.preparation !== null);
    },
    hasNodeEnrollmentOwner(nodeId: string) {
      assertActive();
      for (const row of environments.values()) {
        if (
          row.nodeDeviceId === nodeId &&
          row.nodeSetupId !== null &&
          !isTerminalWorkerEnvironmentState(row.state)
        ) {
          assertReadable(row.environmentId, "environment");
          return true;
        }
      }
      return false;
    },
    hasPendingNodeEnrollmentSetup(setup: string, device: string) {
      assertActive();
      const setupId = setup.trim();
      const deviceId = device.trim();
      if (!setupId || !deviceId) {
        return false;
      }
      let matches = 0;
      for (const row of environments.values()) {
        if (
          row.nodeSetupId === setupId &&
          row.destroyRequestedAtMs === null &&
          ((row.state === "provisioning" && row.nodeDeviceId === null) ||
            (["provisioning", "bootstrapping", "ready", "idle", "attached"].includes(row.state) &&
              row.nodeDeviceId === deviceId))
        ) {
          assertReadable(row.environmentId, "environment");
          matches += 1;
          if (matches === 2) {
            return false;
          }
        }
      }
      return matches === 1;
    },
    get(id: string) {
      assertReadable(id, "environment");
      const record = environments.get(id);
      if (record) {
        assertShape(record);
      }
      return record;
    },
    transferOwner(id: string) {
      assertReadable(id, "transfer");
      const row = environments.get(id);
      if (!row) {
        return undefined;
      }
      const credential = credentials.get(id);
      return {
        environment: {
          ownerEpoch: row.ownerEpoch,
          attachedSessionIds: row.attachedSessionIds,
          destroyRequestedAtMs: row.destroyRequestedAtMs,
          state: row.state,
        },
        credential: credential
          ? {
              ownerEpoch: credential.ownerEpoch,
              expiresAtMs: credential.expiresAtMs,
              sessionId: credential.sessionId,
            }
          : undefined,
      };
    },
    credential(id: string) {
      assertReadable(id, "credential");
      return credentials.get(id);
    },
    credentialByHash(hash: string) {
      assertActive();
      for (const row of credentials.values()) {
        if (row.credentialHash === hash) {
          assertReadable(row.environmentId, "credential");
          return row;
        }
      }
      return undefined;
    },
    list(reconcile = false) {
      assertActive();
      sorted ??= freezeJsonSnapshot([...environments.values()].toSorted(compare));
      if (!reconcile) {
        sorted.forEach(assertShape);
        return sorted;
      }
      reconcilable ??= freezeJsonSnapshot(
        sorted
          .filter((row) => !isTerminalWorkerEnvironmentState(row.state))
          .toSorted(
            (a, b) =>
              Buffer.compare(Buffer.from(a.providerId), Buffer.from(b.providerId)) || compare(a, b),
          ),
      );
      reconcilable.forEach(assertShape);
      return reconcilable;
    },
    hasSessionAttachment(environmentId: string) {
      assertReadable(environmentId, "attachment");
      for (const row of attachments.values()) {
        if (row.environmentId === environmentId) {
          return true;
        }
      }
      return false;
    },
    attachment(sessionId: string) {
      assertActive();
      const row = attachments.get(sessionId);
      if (row) {
        assertReadable(row.environmentId, "attachment");
      }
      return row;
    },
    attachments() {
      assertActive();
      return [...attachments.values()];
    },
    close,
  };
}

function createWorkerEnvironmentProjectionRegistry() {
  type Owner = ReturnType<typeof createWorkerEnvironmentProjection>;
  const owners = new Map<string, { owner: Owner; identity: () => DatabasePathIdentity }>();
  const get = (identity: DatabasePathIdentity): Owner | undefined => {
    for (const [key, entry] of owners) {
      const current = entry.identity();
      if (
        key !== identity.key &&
        current.key !== identity.key &&
        !(current.key.startsWith("path:") && current.canonicalPath === identity.canonicalPath)
      ) {
        continue;
      }
      if (!entry.owner.active) {
        owners.delete(key);
        return undefined;
      }
      // First creation promotes the existing admission even through another filesystem alias.
      if (identity.key.startsWith("file:") && key !== identity.key) {
        owners.delete(key);
        owners.set(identity.key, entry);
      }
      return entry.owner;
    }
    return undefined;
  };
  const remove = (owner: Owner) => {
    for (const [key, entry] of owners) {
      if (entry.owner === owner) {
        owners.delete(key);
      }
    }
  };
  return {
    get,
    acquire(identity: () => DatabasePathIdentity): Owner {
      const current = identity();
      const existing = get(current);
      if (existing) {
        return existing;
      }
      const owner = createWorkerEnvironmentProjection();
      owners.set(current.key, { owner, identity });
      return owner;
    },
    remove,
    invalidate(identity: DatabasePathIdentity | undefined, pathname: string) {
      const owner = identity ? get(identity) : owners.get(`path:${pathname}`)?.owner;
      if (!owner) {
        return;
      }
      owner.close();
      remove(owner);
    },
    close() {
      for (const { owner } of owners.values()) {
        owner.close();
      }
      owners.clear();
    },
  };
}

export const workerEnvironmentProjections = resolveGlobalSingleton(
  Symbol.for("openclaw.workerEnvironmentProjections"),
  createWorkerEnvironmentProjectionRegistry,
  (owners) => owners.close(),
);
