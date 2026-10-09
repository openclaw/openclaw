import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import type {
  CommandProcessCustody,
  CommandProcessIdentity,
} from "../process/command-process-custody.types.js";
import { managedCommandCustody } from "./update-managed-service-handoff-children.js";
import {
  prepareManagedHandoffLeaseDatabaseIdentity,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import {
  prepareManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";

export type ManagedCommandProcessAuthority = {
  runId: string;
  parents: readonly ManagedHandoffParent[];
  databaseIdentity: ManagedUpdateLeaseDatabaseIdentity;
};

/** Adapt command-process settlement to the existing durable update lease owner. */
export async function createManagedCommandProcessCustody(options: {
  roots: readonly string[];
  runId: string;
  databasePath?: string;
  databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  parents?: readonly ManagedHandoffParent[];
  anchorOwner?: string;
  assertCurrent?: () => void;
}): Promise<{
  custody: CommandProcessCustody;
  databasePath: string;
  databaseIdentity: ManagedUpdateLeaseDatabaseIdentity;
  releaseAnchors: () => void;
  prepareSettlement: (
    helperPid: number,
    identities: readonly CommandProcessIdentity[],
  ) => { retire: () => void; diagnostics: string[] };
}> {
  const roots = [...new Set(options.roots)];
  if (!roots.length || roots.some((root) => !root || root.endsWith("/"))) {
    throw new Error("Managed command custody requires installation roots");
  }
  const requestedPath =
    options.databasePath ??
    options.databaseIdentity?.databasePath ??
    resolveManagedUpdateLeaseDatabasePath();
  options.assertCurrent?.();
  const databaseIdentity =
    options.databaseIdentity ??
    (await prepareManagedHandoffLeaseDatabaseIdentity(requestedPath, options.assertCurrent));
  const databasePath = databaseIdentity.databasePath;
  if (options.databasePath && options.databaseIdentity && options.databasePath !== databasePath) {
    throw new Error("Managed command custody database path changed");
  }
  const store = await prepareManagedHandoffLeaseStore({
    databasePath,
    existingIdentity: databaseIdentity,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  options.assertCurrent?.();
  const anchorOwner = options.anchorOwner ?? `doctor:${randomUUID()}`;
  const parents = new Map(options.parents?.map((parent) => [parent.key, parent]));
  const anchors = new Map<string, ManagedHandoffLease>();
  function releaseAnchors(leases = [...anchors.values()]) {
    if (leases.length && !store.releaseAll(leases)) {
      throw new Error("Doctor root custody changed before settlement");
    }
    for (const lease of leases) {
      anchors.delete(lease.key);
    }
  }
  const custody: CommandProcessCustody = {
    reserve(argv) {
      options.assertCurrent?.();
      const child = `.openclaw-update-child-${randomUUID()}-command`;
      let leases: ManagedHandoffLease[] = [];
      try {
        for (const root of roots) {
          let parent = parents.get(root) ?? anchors.get(root);
          if (!parent) {
            if (root.includes("/.openclaw-update-child-")) {
              throw new Error("Doctor command custody requires its delegated parent authority");
            }
            // Shipped updaters inspect descendants only after finding a canonical root.
            const anchor = store.acquire(root, anchorOwner, { kind: "update" });
            if (anchor.kind !== "acquired") {
              throw new Error("Doctor root custody is busy");
            }
            anchors.set(root, anchor.lease);
            parent = anchor.lease;
          }
          const acquired = store.acquire(
            `${root}/${child}`,
            options.runId,
            { kind: "update", custody: "reserved" },
            false,
            parent.version === 1 ? parent : undefined,
            parent.version === 1 ? undefined : parent,
          );
          if (acquired.kind !== "acquired") {
            throw new Error("Managed command custody reservation is busy");
          }
          leases.push(acquired.lease);
        }
      } catch (error) {
        // No spawn has been requested while constructing the reservation.
        for (const lease of leases) {
          store.releaseCommandReservation(lease);
        }
        throw error;
      }
      let bound = false;
      return {
        spawned({ pid }) {
          options.assertCurrent?.();
          const next = store.bindUpdateChildren(leases, pid, argv);
          if (!next) {
            throw new Error("Managed command custody binding was not retained");
          }
          leases = next;
          bound = true;
        },
        settled() {
          const released = bound
            ? store.releaseAll(leases)
            : leases.map((lease) => store.releaseCommandReservation(lease)).every(Boolean);
          if (!released) {
            throw new Error("Managed command custody settlement was not retained");
          }
        },
      };
    },
  };
  return {
    custody,
    databasePath,
    databaseIdentity,
    releaseAnchors,
    prepareSettlement(helperPid, identities) {
      const ownedAnchors = roots.flatMap((root) => {
        if (root.includes("/.openclaw-update-child-")) {
          return [];
        }
        const current = store.read(root);
        if (current.kind !== "current" || current.lease.owner !== anchorOwner) {
          return [];
        }
        const lease = current.lease;
        if (
          lease.version !== 2 ||
          !isDeepStrictEqual(lease.action, { kind: "update" }) ||
          !isDeepStrictEqual(lease.helper, lease.executor) ||
          lease.mutationOriginal !== undefined ||
          lease.helper.pid !== helperPid ||
          lease.executor.pid !== helperPid
        ) {
          throw new Error(`Doctor root custody changed for PID ${helperPid}`);
        }
        return [lease];
      });
      const expected = new Map(identities.map((identity) => [identity.pid, identity]));
      if (expected.size !== identities.length) {
        throw new Error("Doctor command inventory contains duplicate process identities");
      }
      const observed = store.readCommandChildren(roots);
      const leases: ManagedHandoffLease[] = [];
      const foreignCustody = new Set<string>();
      const aliases = new Map<
        number,
        { name: string; helper: string; birth: string; roots: Set<string> }
      >();
      for (const lease of observed) {
        const identity = expected.get(lease.executor.pid);
        // Installation roots are shared; another helper cannot settle this Doctor's receipt.
        if (lease.helper.pid !== helperPid && !identity) {
          foreignCustody.add(
            `Native command PID ${lease.executor.pid}: foreign custody, owned by Doctor ${lease.helper.pid}. Installation replacement remains blocked while that custody is live.`,
          );
          continue;
        }
        if (lease.owner !== options.runId || lease.helper.pid !== helperPid) {
          throw new Error(
            `Native command custody for PID ${lease.executor.pid} belongs to another Doctor`,
          );
        }
        const namespace = roots.find((root) => {
          const prefix = `${root}/`;
          return (
            lease.key.startsWith(prefix) &&
            /^\.openclaw-update-child-[a-f0-9-]{36}-command$/.test(lease.key.slice(prefix.length))
          );
        });
        if (managedCommandCustody(lease) !== "bound" || !identity || !namespace) {
          throw new Error(`Unmatched native command reservation for PID ${lease.executor.pid}`);
        }
        // Published Darwin lease identities retain epoch seconds; physical custody uses microseconds.
        const birth =
          identity.startedAt === null
            ? undefined
            : String(
                process.platform === "darwin"
                  ? Math.floor(identity.startedAt / 1_000_000)
                  : identity.startedAt,
              );
        if (birth !== undefined && lease.executor.startIdentity !== birth) {
          throw new Error(`Native command birth identity changed for PID ${identity.pid}`);
        }
        const name = lease.key.slice(namespace.length + 1);
        const alias = aliases.get(identity.pid);
        if (
          alias &&
          (alias.name !== name ||
            alias.helper !== lease.helper.startIdentity ||
            alias.birth !== lease.executor.startIdentity ||
            alias.roots.has(namespace))
        ) {
          throw new Error(`Native command aliases disagree for PID ${identity.pid}`);
        }
        const current = alias ?? {
          name,
          helper: lease.helper.startIdentity,
          birth: lease.executor.startIdentity,
          roots: new Set<string>(),
        };
        current.roots.add(namespace);
        aliases.set(identity.pid, current);
        leases.push(lease);
      }
      for (const identity of identities) {
        const alias = aliases.get(identity.pid);
        if (alias ? alias.roots.size !== roots.length : isChildProcessTreeAlive(identity)) {
          throw new Error(`Native command aliases are incomplete for PID ${identity.pid}`);
        }
      }
      return {
        diagnostics: [...foreignCustody],
        retire() {
          if (leases.length && !store.releaseAll(leases)) {
            throw new Error(
              `Native command retirement changed for PIDs ${identities.map(({ pid }) => pid).join(", ")}`,
            );
          }
          releaseAnchors(ownedAnchors);
        },
      };
    },
  };
}
