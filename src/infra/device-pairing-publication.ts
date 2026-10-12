import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
  DevicePairingBinding,
  DevicePairingBindingFact,
  DevicePairingCommitReceipt,
  DevicePairingNodeSnapshot,
} from "./device-pairing-read.types.js";
import type { PairedDevice } from "./device-pairing.types.js";

type Publication = {
  identity: string;
  canonicalPath: string;
  epoch: number;
  revision?: string;
  blocked: boolean;
  mutation?: { invalidatesAuthority: boolean };
  complete: boolean;
  rows: Map<string, DevicePairingBinding | null>;
  nodes?: DevicePairingNodeSnapshot;
  pending: Set<() => void>;
};

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
    };
  }
  publications.set(path, publication);
  publications.set(identity.canonicalPath, publication);
  publications.set(identity.key, publication);
  const captured = publication;
  const epoch = captured.epoch;
  const install = (rows: readonly DevicePairingBindingFact[]) => {
    for (const row of rows) {
      captured.rows.set(row.deviceId, row.binding ? { ...row.binding } : null);
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
        for (const [deviceId, binding] of captured.rows) {
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
      const mutation: NonNullable<Publication["mutation"]> = { invalidatesAuthority };
      captured.mutation = mutation;
      return {
        publish(receipt: DevicePairingCommitReceipt) {
          if (publications.get(path) !== captured || captured.mutation !== mutation) {
            return;
          }
          if (receipt.beforeRevision !== captured.revision) {
            captured.complete = false;
            captured.rows.clear();
          }
          if (receipt.revision !== captured.revision) {
            captured.nodes = undefined;
          }
          install(receipt.changed);
          captured.revision = receipt.revision;
          captured.blocked = false;
          captured.mutation = undefined;
          // A reader admitted during this transaction cannot republish its older snapshot.
          captured.epoch++;
        },
        finish(settled: boolean) {
          if (settled && captured.mutation === mutation) {
            captured.mutation = undefined;
            captured.epoch++;
          } else if (!settled && captured.mutation === mutation) {
            captured.blocked = true;
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
  const binding = publication.rows.get(deviceId);
  return binding ? { ...binding } : null;
}
