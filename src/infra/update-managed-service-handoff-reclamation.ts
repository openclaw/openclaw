import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import type { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
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
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffRepair,
  ManagedHandoffLeaseTransition,
} from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { managedHandoffLeaseText as text } from "./update-managed-service-handoff-rows.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import {
  parseManagedHandoffLeasePayload,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";

type Rows = ReturnType<typeof createManagedHandoffLeaseRows>;

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
      ? {
          key: original.key,
          owner: original.owner,
          payload: original.payload,
          updatedAt: original.updatedAt,
        }
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
      if (
        !deps.deleteRow(db, lease.key, {
          owner: lease.owner,
          payload_json: lease.payload,
          updated_at: lease.updatedAt,
        })
      ) {
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

export async function prepareManagedHandoffRepair(
  store: Pick<Rows, "read"> & {
    transact: <T>(db: DatabaseSync, operation: () => T) => T;
    hasUnsettledChildren: (lease: ManagedHandoffLease | string, db?: DatabaseSync) => boolean;
    processIdentity: () => ManagedHandoffLease["helper"];
    bootIdentity: ReturnType<typeof createManagedHandoffBootIdentityReader>;
    owns: (lease: ManagedHandoffLease) => boolean;
    current: (lease: ManagedHandoffLease) => boolean;
    settle: (lease: ManagedHandoffLease, phase: "closed") => ManagedHandoffLease | null;
    release: (lease: ManagedHandoffLease) => boolean;
    releaseAll: (leases: ManagedHandoffLease[]) => boolean;
  },
  context: {
    rows: Pick<Rows, "handle" | "updateRow" | "row" | "descendants">;
    withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
    processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
    reclaimable: (lease: ManagedHandoffLease, db?: DatabaseSync) => boolean;
    cas: ManagedHandoffLeaseTransition;
  },
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<ManagedHandoffRepair | null> {
  const { rows, withDatabase, processState, reclaimable, cas } = context;
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
  const assertDead = () => {
    const pids = [previous, ...children]
      .flatMap((lease) => [lease.helper, lease.executor])
      .filter((owner) => processState(owner) !== "dead")
      .map((owner) => owner.pid);
    if (pids.length) {
      throw new Error(
        `Handoff owners are live or unverified: PID ${[...new Set(pids)].join(", ")}. Wait for their updater or stop it through its owning terminal; verify process-inspection permissions using the original OS account, then run openclaw update repair.`,
      );
    }
  };
  assertDead();
  const assertChildrenSettled = (db: DatabaseSync) => {
    if (
      store.hasUnsettledChildren(root, db) ||
      children.some((child) => !legacyUpdateChild(child) || !reclaimable(child, db))
    ) {
      throw new Error(
        "Handoff descendants remain live or unverified. Wait for their updater and verify process-inspection permissions, then run openclaw update repair.",
      );
    }
  };
  withDatabase(false, assertChildrenSettled);
  const metadata = withDatabase(true, (db) =>
    readManagedHandoffRepairMetadata(db, previous, (operation) => store.transact(db, operation)),
  );
  if (previous.action.kind === "triage" && previous.action.phase !== "uncertain" && !metadata) {
    return null;
  }
  const source = metadata?.source ?? {
    owner: previous.owner,
    payload_json: previous.payload,
    updated_at: previous.updatedAt,
  };
  const { recordUpdateRunStep } = await import("./update-run-ledger.js");
  const discovered = await readManagedHandoffRepairFacts(
    rows.handle(previous.key, source),
    env,
    metadata?.facts.runIds[0],
  );
  let facts = await inspectManagedHandoffRepairFacts(previous, discovered, metadata?.facts);
  const retainedChildren = children.filter((child) => child.key !== previous.key);
  for (const child of retainedChildren) {
    const childFacts = await readManagedHandoffRepairFacts(child, env);
    facts = await inspectManagedHandoffRepairFacts(child, childFacts, facts);
  }
  // Keep the original child key with its existing recovery metadata after
  // promoting an orphan to the installation's exclusive repair claim.
  if (previous.key !== root && !facts.artifactPaths.includes(previous.key)) {
    facts.artifactPaths.push(previous.key);
  }
  facts.timeoutMs = Math.max(facts.timeoutMs ?? 0, timeoutMs ?? 0) || null;
  const helper = store.processIdentity();
  const action: ManagedHandoffLeaseAction = {
    kind: "triage",
    phase: "running",
    lifetime: { kind: "foreground", boot: store.bootIdentity() },
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
      assertDead();
      assertChildrenSettled(db);
      if (
        !isDeepStrictEqual(readChildren(db), children) ||
        (previous.key !== root && rows.row(db, root)) ||
        !rows.updateRow(db, previous, {
          install_root: root,
          owner: next.owner,
          payload_json: next.payload,
          updated_at: next.updatedAt,
          recovery_json: recovery(next),
        })
      ) {
        throw new Error("Handoff ownership changed; retry openclaw update repair.");
      }
    }),
  );
  const assertCurrent = () => {
    if (!store.owns(next) || store.hasUnsettledChildren(next)) {
      throw new Error("Handoff repair lost ownership; retry openclaw update repair.");
    }
  };
  return {
    assertCurrent,
    bindRun(runId: string) {
      assertCurrent();
      facts.runIds.push(runId);
      const bound = cas(next, action, undefined, recovery);
      if (!bound) {
        throw new Error("Handoff repair lost ownership; retry openclaw update repair.");
      }
      next = bound;
    },
    complete(runId: string) {
      assertCurrent();
      if (!facts.runIds.includes(runId)) {
        throw new Error("Handoff settlement requires its bound repair run.");
      }
      const endedAtMs = Date.now();
      const detail = `legacy handoff lease reclaimed: owners proven dead, lease last recorded at ${new Date(previous.updatedAt).toISOString()}, no live descendants. Reclaimed keys: ${[previous.key, ...retainedChildren.map((child) => child.key)].join(", ")}. Current-installation repair completed.`;
      const result = recordUpdateRunStep(
        runId,
        { step: "finalize:handoff-settlement", status: "completed", endedAtMs, detail },
        { env },
      );
      const receipt = result.steps.find((step) => step.step === "finalize:handoff-settlement");
      if (receipt?.status !== "completed" || receipt.endedAtMs !== endedAtMs) {
        throw new Error("Handoff settlement was not recorded; retry openclaw update repair.");
      }
      const closed = store.settle(next, "closed");
      if (
        !closed ||
        !(retainedChildren.length
          ? store.releaseAll([...retainedChildren, closed])
          : store.release(closed))
      ) {
        throw new Error(
          "Handoff repair completed but its lease remains; retry openclaw update repair.",
        );
      }
    },
    [Symbol.dispose]() {
      if (store.current(next)) {
        cas(next, { ...action, phase: "uncertain" }, undefined, recovery);
      }
    },
  };
}
