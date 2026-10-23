import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  predatesCurrentBoot,
  type createManagedHandoffBootIdentityReader,
} from "./update-managed-service-handoff-boot.js";
import { readCancelledUpdateFamily } from "./update-managed-service-handoff-cancellation.js";
import {
  managedCommandCustody,
  managedCommandUnsettled,
} from "./update-managed-service-handoff-children.js";
import {
  canCleanupLegacyManagedHandoff,
  readManagedHandoffRepairFacts,
  inspectManagedHandoffRepairFacts,
} from "./update-managed-service-handoff-cleanup.js";
import {
  leaseQueries,
  managedHandoffLeaseBinding as binding,
  readManagedHandoffRepairMetadata,
  type createManagedHandoffLeaseDatabase,
  type LeaseRow,
  type ManagedHandoffRepairFacts,
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffRepair,
  ManagedHandoffRetainedCustody,
} from "./update-managed-service-handoff-lease-types.js";
import {
  hasOriginalUpdateExecutorCustody,
  managedHandoffOriginalGeneration,
} from "./update-managed-service-handoff-original-owner.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import {
  managedHandoffLeaseRow,
  managedHandoffLeaseText as text,
} from "./update-managed-service-handoff-rows.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import {
  managedHandoffBootSchema,
  parseManagedHandoffLeasePayload,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";
import type { createManagedHandoffScopeReader } from "./update-managed-service-handoff-scope.js";

type Rows = ReturnType<typeof createManagedHandoffLeaseRows>;

export function createManagedHandoffReclaimability({
  bootIdentity,
  processState,
  nativeClosed,
  hasUnsettledChildren,
  withDatabase,
  transact,
}: {
  bootIdentity: ReturnType<typeof createManagedHandoffBootIdentityReader>;
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
  nativeClosed: ReturnType<typeof createManagedHandoffScopeReader>["nativeClosed"];
  hasUnsettledChildren: (lease: ManagedHandoffLease, db?: DatabaseSync) => boolean;
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  transact: <T>(db: DatabaseSync, operation: () => T) => T;
}) {
  return function reclaimable(lease: ManagedHandoffLease, db?: DatabaseSync) {
    // No process/boot liveness observation is a join receipt.
    if (lease.version === 3 || lease.version === 4 || hasOriginalUpdateExecutorCustody(lease)) {
      return false;
    }
    const action = lease.action;
    if (managedCommandCustody(lease)) {
      return !managedCommandUnsettled(lease) && !hasUnsettledChildren(lease, db);
    }
    if (action.kind === "triage" && action.lifetime.kind === "foreground") {
      const boot = bootIdentity();
      if (
        boot.platform === action.lifetime.boot.platform &&
        boot.identity !== action.lifetime.boot.identity
      ) {
        const repair = (connection: DatabaseSync) =>
          readManagedHandoffRepairMetadata(connection, lease, (operation) =>
            transact(connection, operation),
          );
        return action.phase === "closed" || !(db ? repair(db) : withDatabase(true, repair));
      }
      if (!["reserved", "closed"].includes(action.phase)) {
        return false;
      }
    }
    if (processState(lease.helper) !== "dead" || processState(lease.executor) !== "dead") {
      return false;
    }
    return (
      !hasUnsettledChildren(lease, db) &&
      (action.kind !== "triage" ||
        action.lifetime.kind !== "native" ||
        nativeClosed(action.lifetime))
    );
  };
}

/** Retire dead command claims and original mirrors with the replacing admission.
 * A shipped parent cannot settle candidate custody after Doctor dies. Retained
 * bound claims must not survive successful repair and fence an older reader. */
export function observeManagedHandoffReclamation(
  root: string,
  original: ManagedHandoffLease | undefined,
  db: DatabaseSync,
  deps: Pick<Rows, "handle" | "deleteRow"> & {
    reclaimable: (lease: ManagedHandoffLease, db: DatabaseSync) => boolean;
    hasUnsettledChildren: (lease: ManagedHandoffLease, db: DatabaseSync) => boolean;
    readCommandChildren: (roots: readonly string[], db?: DatabaseSync) => ManagedHandoffLease[];
    processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
  },
): () => boolean {
  const generation =
    original?.version === 2 &&
    !original.mutationOriginal &&
    original.action.kind === "update" &&
    original.action.mutationProtocol === "original-cancellation-v1"
      ? managedHandoffOriginalGeneration(original)
      : undefined;
  const readPairs = () =>
    generation
      ? executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .selectFrom("managed_update_handoffs")
            .select(["install_root", "owner", "payload_json", "updated_at"])
            .orderBy("install_root"),
        ).rows.flatMap((row) => {
          const payload = parseManagedHandoffLeasePayload(row.payload_json);
          return payload?.version === 2 && isDeepStrictEqual(payload.mutationOriginal, generation)
            ? [{ row, lease: deps.handle(row.install_root, row) }]
            : [];
        })
      : [];
  const observed = readPairs();
  const roots = [root, ...observed.map(({ lease }) => lease.key)];
  const readCommands = () =>
    deps.readCommandChildren(roots, db).toSorted((a, b) => a.key.localeCompare(b.key));
  const commands = readCommands();
  const commandSettled = (lease: ManagedHandoffLease) =>
    managedCommandCustody(lease) === "bound" &&
    deps.processState(lease.helper) === "dead" &&
    !managedCommandUnsettled(lease);
  const dead =
    observed.every(({ lease }) => deps.reclaimable(lease, db)) && commands.every(commandSettled);
  // The caller runs this only after revalidating the exact original observation
  // and its descendants, inside the same transaction that replaces that row.
  return () => {
    const current = readPairs();
    if (
      !dead ||
      !isDeepStrictEqual(current, observed) ||
      !isDeepStrictEqual(readCommands(), commands) ||
      !commands.every(commandSettled) ||
      current.some(({ lease }) => deps.hasUnsettledChildren(lease, db))
    ) {
      return false;
    }
    for (const lease of commands) {
      if (!deps.deleteRow(db, lease.key, managedHandoffLeaseRow(lease))) {
        throw new Error("Managed command custody changed during reclamation");
      }
    }
    for (const { row } of current) {
      if (!deps.deleteRow(db, row.install_root, row)) {
        throw new Error("Original update mirror changed during reclamation");
      }
    }
    return true;
  };
}

export function readManagedHandoffAdmissionLease(
  root: string,
  value: LeaseRow | undefined,
  handle: Rows["handle"],
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"],
) {
  // Only admission may retire a positively dead legacy row. Keep its complete
  // observation for the transaction CAS; read/handles require a supported strict schema.
  const legacyDead =
    value &&
    text.safeParse(value.owner).success &&
    Number.isSafeInteger(value.updated_at) &&
    value.updated_at >= 0 &&
    canCleanupLegacyManagedHandoff(value.payload_json, processState);
  return value && !legacyDead ? handle(root, value) : null;
}

type RepairStore = Pick<Rows, "read"> & {
  transact: <T>(db: DatabaseSync, operation: () => T) => T;
  hasUnsettledChildren: (lease: ManagedHandoffLease | string, db?: DatabaseSync) => boolean;
  processIdentity: () => ManagedHandoffLease["helper"];
  bootIdentity: ReturnType<typeof createManagedHandoffBootIdentityReader>;
  owns: (lease: ManagedHandoffLease) => boolean;
  settle: (lease: ManagedHandoffLease, phase: "closed") => ManagedHandoffLease | null;
  release: (lease: ManagedHandoffLease) => boolean;
};
type RepairContext = {
  rows: Pick<Rows, "handle" | "updateRow" | "deleteRow" | "row" | "descendants">;
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
  reclaimable: (lease: ManagedHandoffLease, db?: DatabaseSync) => boolean;
  childAliases: (key: string, db: DatabaseSync) => string[];
};

function describeCancelledCustody(lease: ManagedHandoffLease) {
  return {
    key: lease.key,
    owner: lease.owner,
    leaseVersion: lease.version,
    lastActivityAt: new Date(lease.updatedAt).toISOString(),
  };
}

/** Repair left cancelled custody in place; its caller still finishes maintenance. */
export class ManagedHandoffCustodyRetainedError extends Error {
  readonly custody: ManagedHandoffRetainedCustody;
  constructor(lease: ManagedHandoffLease, cause: unknown) {
    const custody = {
      ...describeCancelledCustody(lease),
      reason: cause instanceof Error ? cause.message : String(cause),
    };
    super(
      `Cancelled update custody remains at ${custody.key} (owner ${custody.owner}, lease version ${custody.leaseVersion}, last activity ${custody.lastActivityAt}): ${custody.reason}`,
      { cause },
    );
    this.name = "ManagedHandoffCustodyRetainedError";
    this.custody = custody;
  }
}

function liveOwnersError(owners: ManagedHandoffLease["helper"][]) {
  return new Error(
    `Handoff owners are live or unverified: PID ${[...new Set(owners.map((owner) => owner.pid))].join(", ")}. Wait for their updater or stop it through its owning terminal; verify process-inspection permissions using the original OS account, then run openclaw update repair.`,
  );
}

const unsettledDescendantsMessage =
  "Handoff descendants remain live or unverified. Wait for their updater and verify process-inspection permissions, then run openclaw update repair.";

function cancelledCustodySettlement(origin: ManagedHandoffLease, keys: readonly string[]) {
  return `cancelled update custody settled: updater PID ${origin.helper.pid} and its descendants proven exited, custody last recorded at ${new Date(origin.updatedAt).toISOString()}, no referencing processes. Settled keys: ${keys.join(", ")}. Current-installation repair completed.`;
}

export async function prepareManagedHandoffRepair(
  store: RepairStore,
  context: RepairContext,
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<ManagedHandoffRepair | null> {
  const { rows, withDatabase, processState, reclaimable } = context;
  const found = store.read(root);
  if (found.kind === "unreadable") {
    throw new Error(
      "Handoff state is unreadable; retain managed-update-handoffs.sqlite and run openclaw doctor --fix.",
    );
  }
  const readChildren = (db: DatabaseSync) =>
    rows.descendants(db, { key: root }).map((entry) => rows.handle(entry.install_root, entry));
  const children = withDatabase(true, readChildren);
  const previous = found.kind === "current" ? found.lease : children[0];
  if (!previous) {
    return null;
  }
  if (previous.version === 4) {
    try {
      return await prepareCancelledCustodyRepair(store, context, root, previous, env, timeoutMs);
    } catch (error) {
      throw new ManagedHandoffCustodyRetainedError(previous, error);
    }
  }
  // Current root owners also omit protocol fields; only child lineage identifies
  // legacy update custody here. Ordinary root reclamation belongs to admission.
  const legacyUpdateChild = (lease: ManagedHandoffLease) =>
    lease.key.startsWith(`${root}/.openclaw-update-child-`) &&
    lease.version === 2 &&
    !lease.mutationOriginal &&
    lease.action.kind === "update" &&
    !lease.action.custody &&
    !lease.action.mutationProtocol;
  if (
    previous.version !== 2 ||
    previous.mutationOriginal ||
    (!legacyUpdateChild(previous) &&
      (previous.action.kind !== "triage" ||
        previous.action.lifetime.kind !== "foreground" ||
        !["running", "uncertain"].includes(previous.action.phase)))
  ) {
    return null;
  }
  let boot: ReturnType<typeof store.bootIdentity> | undefined;
  try {
    boot = managedHandoffBootSchema.parse(store.bootIdentity());
  } catch {
    // Missing boot evidence must not bypass the normal liveness checks.
  }
  const familyExited = (lease: ManagedHandoffLease) => {
    const lifetime = lease.action.kind === "triage" ? lease.action.lifetime : undefined;
    if (
      lifetime?.kind === "foreground" &&
      managedHandoffBootSchema.safeParse(lifetime.boot).success
    ) {
      return (
        boot !== undefined &&
        boot.platform === lifetime.boot.platform &&
        boot.identity !== lifetime.boot.identity
      );
    }
    return predatesCurrentBoot(lease.updatedAt, boot);
  };
  const metadata = withDatabase(true, (db) =>
    readManagedHandoffRepairMetadata(db, previous, (operation) => store.transact(db, operation)),
  );
  if (previous.action.kind === "triage" && previous.action.phase !== "uncertain" && !metadata) {
    return null;
  }
  const source = metadata?.source ?? managedHandoffLeaseRow(previous);
  const sourceLease = rows.handle(previous.key, source);
  const resume = async () => {
    const assertDead = () => {
      const owners = [previous, ...children]
        .flatMap((lease) => (familyExited(lease) ? [] : [lease.helper, lease.executor]))
        .filter((owner) => processState(owner) !== "dead");
      if (owners.length) {
        throw liveOwnersError(owners);
      }
    };
    assertDead();
    const assertChildrenSettled = (db: DatabaseSync) => {
      // A proven reboot closes legacy process claims, never newer receipt-owned custody.
      if (
        !children.every((child) => legacyUpdateChild(child) && familyExited(child)) &&
        (store.hasUnsettledChildren(root, db) ||
          children.some((child) => !legacyUpdateChild(child) || !reclaimable(child, db)))
      ) {
        throw new Error(unsettledDescendantsMessage);
      }
    };
    withDatabase(false, assertChildrenSettled);
    const discovered = await readManagedHandoffRepairFacts(
      sourceLease,
      env,
      metadata?.facts.runIds[0],
    );
    // An interrupted cancelled-custody claim existed only after that family's grace
    // elapsed. Count from the cancelled source, not the claim; the claim's own
    // process and the census remain checked.
    let facts = await inspectManagedHandoffRepairFacts(
      sourceLease.version === 4 ? sourceLease : previous,
      sourceLease.version === 4
        ? { ...discovered, drivers: [...(discovered.drivers ?? []), previous.helper] }
        : discovered,
      metadata?.facts,
      familyExited(previous),
    );
    const retainedChildren = children.filter((child) => child.key !== previous.key);
    for (const child of retainedChildren) {
      const childFacts = await readManagedHandoffRepairFacts(child, env);
      facts = await inspectManagedHandoffRepairFacts(child, childFacts, facts, familyExited(child));
    }
    // Keep the original child key with its existing recovery metadata after
    // promoting an orphan to the installation's exclusive repair claim.
    if (previous.key !== root && !facts.artifactPaths.includes(previous.key)) {
      facts.artifactPaths.push(previous.key);
    }
    facts.timeoutMs = Math.max(facts.timeoutMs ?? 0, timeoutMs ?? 0) || null;
    const settledKeys = [previous.key, ...retainedChildren.map((child) => child.key)];
    return await claimManagedHandoffRepair(store, context, root, previous, source, facts, env, {
      boot,
      unchanged: (db) => {
        assertDead();
        assertChildrenSettled(db);
        return (
          isDeepStrictEqual(readChildren(db), children) &&
          (previous.key === root || !rows.row(db, root))
        );
      },
      retained: retainedChildren,
      settled: (db, retained) => {
        assertChildrenSettled(db);
        if (!isDeepStrictEqual(readChildren(db), retained)) {
          throw new Error("Handoff children changed; retry openclaw update repair.");
        }
      },
      // A resumed cancelled-custody repair keeps describing what it settles.
      ...(sourceLease.version === 4
        ? {
            cancelled: sourceLease,
            settlement: cancelledCustodySettlement(sourceLease, settledKeys),
          }
        : {
            settlement: `legacy handoff lease reclaimed: owners proven dead, lease last recorded at ${new Date(previous.updatedAt).toISOString()}, no verified live descendants or runtime holders. Reclaimed keys: ${settledKeys.join(", ")}. Current-installation repair completed.`,
          }),
    });
  };
  if (sourceLease.version !== 4) {
    return await resume();
  }
  // An interrupted cancelled-custody repair still guards that custody.
  try {
    return await resume();
  } catch (error) {
    throw new ManagedHandoffCustodyRetainedError(sourceLease, error);
  }
}

/** Settle a dead original's cancellation through the same explicit claim and
 * receipt. Its generations, dependents and descendants must all be proven
 * exited; the claim replaces the original and retires the rest atomically. */
async function prepareCancelledCustodyRepair(
  store: RepairStore,
  context: RepairContext,
  root: string,
  origin: ManagedHandoffLease,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<ManagedHandoffRepair> {
  const { rows, withDatabase, processState, childAliases } = context;
  const readFamily = (db: DatabaseSync) =>
    readCancelledUpdateFamily(db, origin, {
      handle: rows.handle,
      descendants: rows.descendants,
      childAliases,
    });
  const family = withDatabase(false, readFamily);
  if (!family.some((lease) => isDeepStrictEqual(lease, origin))) {
    throw new Error("Handoff ownership changed; retry openclaw update repair.");
  }
  const assertDead = () => {
    const owners = family
      .flatMap((lease) => [lease.helper, lease.executor])
      .filter((owner) => processState(owner) !== "dead");
    if (owners.length) {
      throw liveOwnersError(owners);
    }
  };
  // Check beneath every member: a root path may itself contain the child marker.
  // The killed updater's own process group can outlive it, e.g. a package install.
  const assertSettled = (db: DatabaseSync) => {
    if (
      family.some((lease) => store.hasUnsettledChildren(lease.key, db)) ||
      (process.platform !== "win32" &&
        family.some((lease) => isChildProcessTreeAlive(lease.executor)))
    ) {
      throw new Error(unsettledDescendantsMessage);
    }
  };
  assertDead();
  withDatabase(false, assertSettled);
  // The run's facts come from its origin, but grace and census cover every row
  // this claim retires: the latest family activity, keys and process identities.
  const discovered = await readManagedHandoffRepairFacts(origin, env);
  const facts = await inspectManagedHandoffRepairFacts(
    family.reduce((latest, lease) => (lease.updatedAt > latest.updatedAt ? lease : latest)),
    {
      ...discovered,
      artifactPaths: [
        ...new Set([...discovered.artifactPaths, ...family.map((lease) => lease.key)]),
      ],
      drivers: [
        ...(discovered.drivers ?? []),
        ...family.flatMap((lease) => [lease.helper, lease.executor]),
      ],
    },
  );
  facts.timeoutMs = Math.max(facts.timeoutMs ?? 0, timeoutMs ?? 0) || null;
  const retired = family.filter((lease) => lease.key !== origin.key);
  return await claimManagedHandoffRepair(
    store,
    context,
    root,
    origin,
    managedHandoffLeaseRow(origin),
    facts,
    env,
    {
      unchanged: (db) => {
        assertDead();
        assertSettled(db);
        return isDeepStrictEqual(readFamily(db), family);
      },
      retire: (db) =>
        retired.every((lease) => rows.deleteRow(db, lease.key, managedHandoffLeaseRow(lease))),
      retained: [],
      // The claim retired every family row; a later unsettled child is a new writer.
      settled: (db) => {
        if (store.hasUnsettledChildren(root, db)) {
          throw new Error(unsettledDescendantsMessage);
        }
      },
      cancelled: origin,
      settlement: cancelledCustodySettlement(
        origin,
        family.map((lease) => lease.key),
      ),
    },
  );
}

/** Replace verified custody with this process's foreground repair claim. Recovery
 * metadata keeps the source and facts until the settlement receipt is durable. */
async function claimManagedHandoffRepair(
  store: RepairStore,
  { rows, withDatabase }: RepairContext,
  root: string,
  previous: ManagedHandoffLease,
  source: LeaseRow,
  facts: ManagedHandoffRepairFacts,
  env: NodeJS.ProcessEnv,
  claim: {
    boot?: ReturnType<RepairStore["bootIdentity"]>;
    unchanged: (db: DatabaseSync) => boolean;
    retire?: (db: DatabaseSync) => boolean;
    /** Claims kept in place until the settlement receipt is durable. */
    retained: ManagedHandoffLease[];
    /** Throws unless the installation's remaining rows still permit this repair. */
    settled: (db: DatabaseSync, retained: ManagedHandoffLease[]) => void;
    cancelled?: ManagedHandoffLease;
    settlement: string;
  },
): Promise<ManagedHandoffRepair> {
  const { recordUpdateRunStep } = await import("./update-run-ledger.js");
  const helper = store.processIdentity();
  const action: ManagedHandoffLeaseAction = {
    kind: "triage",
    phase: "running",
    lifetime: {
      kind: "foreground",
      boot: claim.boot ?? managedHandoffBootSchema.parse(store.bootIdentity()),
    },
  };
  let next = rows.handle(root, {
    owner: randomUUID(),
    payload_json: JSON.stringify({ version: 2, executor: helper, helper, action }),
    updated_at: Math.max(Date.now(), previous.updatedAt + 1),
  });
  const recovery = (lease: ManagedHandoffLease) =>
    JSON.stringify({ version: 3, binding: binding(lease), source, facts });
  withDatabase(true, (db) =>
    store.transact(db, () => {
      if (
        !claim.unchanged(db) ||
        !rows.updateRow(db, previous, {
          install_root: root,
          owner: next.owner,
          payload_json: next.payload,
          updated_at: next.updatedAt,
          recovery_json: recovery(next),
        }) ||
        (claim.retire && !claim.retire(db))
      ) {
        throw new Error("Handoff ownership changed; retry openclaw update repair.");
      }
    }),
  );
  let retained = claim.retained;
  const assertCurrent = (db?: DatabaseSync) => {
    if (!store.owns(next)) {
      throw new Error("Handoff repair lost ownership; retry openclaw update repair.");
    }
    if (db) {
      claim.settled(db, retained);
    } else {
      withDatabase(false, (connection) => claim.settled(connection, retained));
    }
  };
  // Repair carries its exact child observations through CAS; generic writers
  // correctly refuse children whose recycled process identities are unreadable.
  const transition = (nextAction: ManagedHandoffLeaseAction) => {
    const changed = rows.handle(root, {
      ...managedHandoffLeaseRow(next),
      payload_json: JSON.stringify({
        version: 2,
        executor: next.executor,
        helper: next.helper,
        action: nextAction,
      }),
      updated_at: Math.max(Date.now(), next.updatedAt + 1),
    });
    withDatabase(true, (db) =>
      store.transact(db, () => {
        assertCurrent(db);
        if (
          !rows.updateRow(db, next, {
            payload_json: changed.payload,
            updated_at: changed.updatedAt,
            recovery_json: recovery(changed),
          })
        ) {
          throw new Error("Handoff repair lost ownership; retry openclaw update repair.");
        }
      }),
    );
    next = changed;
  };
  return {
    ...(claim.cancelled ? { cancelledCustody: describeCancelledCustody(claim.cancelled) } : {}),
    assertCurrent,
    bindRun(runId: string) {
      facts.runIds.push(runId);
      transition(action);
    },
    complete(runId: string) {
      assertCurrent();
      if (!facts.runIds.includes(runId)) {
        throw new Error("Handoff settlement requires its bound repair run.");
      }
      const result = recordUpdateRunStep(
        runId,
        {
          step: "finalize:handoff-settlement",
          status: "completed",
          endedAtMs: Date.now(),
          detail: claim.settlement,
        },
        { env },
      );
      const receipt = result?.steps.find((step) => step.step === "finalize:handoff-settlement");
      if (receipt?.status !== "completed") {
        throw new Error("Handoff settlement was not recorded; retry openclaw update repair.");
      }
      // Only the durable settlement receipt permits removing the retained claims.
      if (retained.length) {
        withDatabase(true, (db) =>
          store.transact(db, () => {
            assertCurrent(db);
            for (const child of retained) {
              if (!rows.deleteRow(db, child.key, managedHandoffLeaseRow(child))) {
                throw new Error("Handoff children changed; retry openclaw update repair.");
              }
            }
          }),
        );
        retained = [];
      }
      const closed = store.settle(next, "closed");
      if (!closed || !store.release(closed)) {
        throw new Error(
          "Handoff repair completed but its lease remains; retry openclaw update repair.",
        );
      }
    },
    [Symbol.dispose]() {
      if (store.owns(next)) {
        transition({ ...action, phase: "uncertain" });
      }
    },
  };
}
