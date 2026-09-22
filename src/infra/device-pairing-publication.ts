import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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
} from "./device-pairing-read.types.js";

type Publication = {
  identity: string;
  canonicalPath: string;
  epoch: number;
  revision?: string;
  blocked: boolean;
  mutation?: object;
  complete: boolean;
  rows: Map<string, DevicePairingBinding | null>;
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
    fail() {
      if (publications.get(path) === captured && captured.epoch === epoch) {
        captured.blocked = true;
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
    beginMutation() {
      captured.epoch++;
      captured.blocked = true;
      const mutation = {};
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
    (!publication.complete && !publication.rows.has(deviceId))
  ) {
    throw new Error("Device pairing authority requires a current worker publication");
  }
  const binding = publication.rows.get(deviceId);
  return binding ? { ...binding } : null;
}
