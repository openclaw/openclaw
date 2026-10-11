import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { PairedDeviceTokenIdentity } from "./device-pairing-core.types.js";
import type {
  DevicePairingBinding,
  DevicePairingBindingFact,
  DevicePairingCommitReceipt,
  DevicePairingNodeSnapshot,
} from "./device-pairing-read.types.js";
import type { PairedDevice } from "./device-pairing.types.js";

const log = createSubsystemLogger("device-pairing");

type Publication = {
  identity: string;
  canonicalPath: string;
  epoch: number;
  revision?: string;
  blocked: boolean;
  mutation?: {
    invalidatesAuthority: boolean;
    receipt?: DevicePairingCommitReceipt;
  };
  complete: boolean;
  rows: Map<string, DevicePairingBindingFact>;
  nodes?: DevicePairingNodeSnapshot;
  pending: Set<() => void>;
  listeners: Map<string, Set<() => void>>;
};

function notifyPairingSources(publication: Publication, deviceIds?: readonly string[]) {
  const listeners = deviceIds
    ? deviceIds.flatMap((deviceId) => Array.from(publication.listeners.get(deviceId) ?? []))
    : Array.from(publication.listeners.values()).flatMap((entries) => Array.from(entries));
  for (const listener of listeners) {
    listener();
  }
}

const publications = resolveGlobalSingleton(
  Symbol.for("openclaw.devicePairingPublications"),
  () => {
    const state = new Map<string, Publication>();
    registerOpenClawStateDatabaseAsyncResource({
      phase: "after-resources",
      async close(identity) {
        for (const [path, publication] of state) {
          if (
            !identity ||
            publication.identity === identity.key ||
            publication.canonicalPath === identity.canonicalPath
          ) {
            state.delete(path);
            notifyPairingSources(publication);
          }
        }
      },
    });
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind === "opened") {
        return;
      }
      for (const [path, publication] of state) {
        if (path === event.path || publication.identity === event.identity?.key) {
          state.delete(path);
          notifyPairingSources(publication);
        }
      }
    });
    return state;
  },
);

/** Native pairing writers retire the node projection after their transaction commits. */
export function invalidateDevicePairingNodeSnapshot(path: string): void {
  const publication = publications.get(path);
  if (publication) {
    publication.epoch++;
    publication.nodes = undefined;
  }
}

export function captureDevicePairingPublication(admission: OpenClawStateDatabaseReadAdmission) {
  const path = admission.databasePath;
  const { identity } = admission;
  let publication = publications.get(identity.key) ?? publications.get(identity.canonicalPath);
  if (publication && publication.identity !== identity.key) {
    for (const [alias, current] of publications) {
      if (current === publication) {
        publications.delete(alias);
      }
    }
    notifyPairingSources(publication);
    publication = undefined;
  }
  if (!publication) {
    publication = {
      identity: identity.key,
      canonicalPath: identity.canonicalPath,
      epoch: 0,
      blocked: false,
      complete: false,
      rows: new Map(),
      pending: new Set(),
      listeners: new Map(),
    };
  }
  publications.set(path, publication);
  publications.set(identity.canonicalPath, publication);
  publications.set(identity.key, publication);
  const captured = publication;
  const epoch = captured.epoch;
  const install = (rows: readonly DevicePairingBindingFact[]) => {
    for (const row of rows) {
      captured.rows.set(row.deviceId, freezeJsonSnapshot(structuredClone(row)));
    }
  };
  return {
    isCurrent: () =>
      publications.get(path) === captured && captured.epoch === epoch && !captured.mutation,
    completeRevision: () =>
      !captured.blocked && captured.complete ? captured.revision : undefined,
    readNodes() {
      for (const service of captured.pending) {
        service();
      }
      return publications.get(path) === captured &&
        !captured.blocked &&
        !captured.mutation &&
        captured.complete
        ? captured.nodes
        : undefined;
    },
    fail() {
      if (publications.get(path) === captured && captured.epoch === epoch) {
        captured.blocked = true;
        captured.nodes = undefined;
        notifyPairingSources(captured);
      }
    },
    publish(
      revision: string,
      rows: readonly DevicePairingBindingFact[] | undefined,
      complete = false,
    ) {
      if (publications.get(path) !== captured || captured.epoch !== epoch || captured.mutation) {
        return false;
      }
      if (!rows) {
        if (captured.revision !== revision || !captured.complete) {
          throw new Error("Pairing publication cannot reuse an unknown revision");
        }
        captured.blocked = false;
        return true;
      }
      if (captured.revision !== revision) {
        captured.epoch++;
        captured.nodes = undefined;
      }
      if (complete || captured.revision !== revision) {
        captured.rows.clear();
        captured.complete = false;
      }
      captured.revision = revision;
      install(rows);
      captured.complete ||= complete;
      captured.blocked = false;
      notifyPairingSources(captured);
      return true;
    },
    prepareNodes(revision: string, paired: PairedDevice[]): DevicePairingNodeSnapshot {
      if (
        publications.get(path) !== captured ||
        captured.blocked ||
        captured.mutation ||
        !captured.complete ||
        captured.revision !== revision
      ) {
        throw new Error("Device pairing nodes require a current worker publication");
      }
      if (!captured.nodes) {
        const bindings = new Map<string, DevicePairingBinding>();
        for (const [deviceId, { binding }] of captured.rows) {
          if (binding) {
            bindings.set(deviceId, Object.freeze({ ...binding }));
          }
        }
        captured.nodes = Object.freeze({
          paired: freezeJsonSnapshot(paired),
          bindings,
        });
      }
      return captured.nodes;
    },
    beginMutation(invalidatesAuthority: boolean) {
      captured.epoch++;
      const mutation: NonNullable<Publication["mutation"]> = {
        invalidatesAuthority,
      };
      captured.mutation = mutation;
      return {
        prepare(receipt: DevicePairingCommitReceipt) {
          if (publications.get(path) !== captured || captured.mutation !== mutation) {
            throw new Error("Pairing commit publication was replaced");
          }
          // Fence the transaction's exact next credential before COMMIT is granted.
          // Reconnect metadata and unrelated writes must not revoke accepted runs.
          mutation.receipt = receipt;
        },
        publish(receipt: DevicePairingCommitReceipt) {
          if (publications.get(path) !== captured || captured.mutation !== mutation) {
            return;
          }
          const replaced = receipt.beforeRevision !== captured.revision;
          if (replaced) {
            captured.rows.clear();
          }
          if (receipt.revision !== captured.revision) {
            captured.nodes = undefined;
          }
          install(replaced ? receipt.bindings : receipt.changed);
          captured.complete ||= replaced;
          captured.revision = receipt.revision;
          captured.blocked = false;
          captured.mutation = undefined;
          // A reader admitted during this transaction cannot republish its older snapshot.
          captured.epoch++;
          notifyPairingSources(
            captured,
            replaced ? undefined : receipt.changed.map((row) => row.deviceId),
          );
        },
        finish(settled: boolean) {
          if (settled && captured.mutation === mutation) {
            captured.mutation = undefined;
            captured.epoch++;
          } else if (!settled && captured.mutation === mutation) {
            captured.blocked = true;
            notifyPairingSources(captured);
          }
        },
      };
    },
    servicePending(service: () => void) {
      captured.pending.add(service);
      return () => captured.pending.delete(service);
    },
  };
}

/** Unknown facts suppress use without declaring an otherwise live node revoked. */
export function getPublishedPairedDeviceBinding(
  deviceId: string,
  baseDir?: string,
): DevicePairingBinding | null {
  const path = resolveOpenClawStateSqlitePath(
    baseDir ? { ...process.env, OPENCLAW_STATE_DIR: baseDir } : process.env,
  );
  const publication = publications.get(path);
  for (const service of publication?.pending ?? []) {
    service();
  }
  if (
    !publication ||
    publication.blocked ||
    publication.mutation?.invalidatesAuthority ||
    (!publication.complete && !publication.rows.has(deviceId))
  ) {
    throw new Error("Device pairing authority requires a current worker publication");
  }
  const binding = publication.rows.get(deviceId)?.binding;
  return binding ? { ...binding } : null;
}

/** Pin the prepared publication, so retained runs cannot follow a successor token or store. */
export function capturePublishedOperatorDeviceSource(
  identity: PairedDeviceTokenIdentity,
  scopes: readonly string[],
  onInvalidated: () => void,
  baseDir?: string,
): { assertCurrent: () => void; release: () => void } {
  const path = resolveOpenClawStateSqlitePath(
    baseDir ? { ...process.env, OPENCLAW_STATE_DIR: baseDir } : process.env,
  );
  const publication = publications.get(path);
  if (!publication) {
    log.warn("operator_pairing_authority_invalidated", {
      reason: "publication_missing",
      deviceId: identity.deviceId,
    });
    throw new Error("Operator device source requires its original current pairing publication");
  }
  const expected = Object.freeze({ ...identity });
  const requestedScopes = [...scopes];
  let released = false;
  let reported = false;
  const assertCurrent = () => {
    for (const service of publication.pending) {
      service();
    }
    // A prepared receipt carries the complete next revision, including sibling writes.
    const receipt = publication.mutation?.receipt;
    const binding = (
      receipt
        ? receipt.bindings.find((row) => row.deviceId === expected.deviceId)
        : publication.rows.get(expected.deviceId)
    )?.operatorBinding;
    const reason = released
      ? "source_released"
      : publications.get(path) !== publication
        ? "publication_replaced"
        : publication.blocked
          ? "publication_blocked"
          : !binding
            ? "operator_binding_missing"
            : binding.identity !== expected.key
              ? "operator_token_changed"
              : !roleScopesAllow({
                    role: "operator",
                    requestedScopes,
                    allowedScopes: binding.scopes,
                  })
                ? "operator_scopes_reduced"
                : undefined;
    if (reason) {
      if (!reported) {
        reported = true;
        log.warn("operator_pairing_authority_invalidated", {
          reason,
          deviceId: expected.deviceId,
          revision: publication.revision,
          complete: publication.complete,
        });
      }
      throw new Error("Operator device source requires its original current pairing publication");
    }
  };
  assertCurrent();
  const recheck = () => {
    try {
      assertCurrent();
    } catch {
      onInvalidated();
    }
  };
  const listeners = publication.listeners.get(expected.deviceId) ?? new Set<() => void>();
  publication.listeners.set(expected.deviceId, listeners);
  listeners.add(recheck);
  return {
    assertCurrent,
    release: () => {
      if (!released) {
        released = true;
        listeners.delete(recheck);
        if (listeners.size === 0) {
          publication.listeners.delete(expected.deviceId);
        }
      }
    },
  };
}
