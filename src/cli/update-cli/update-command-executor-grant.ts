import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { admitUpdateInitialStoreTransport } from "../../infra/update-initial-store-transport.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  childLineageDigest,
  type UpdateCommandChildGrant,
} from "./update-command-executor-children.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
export type { UpdateCommandChildGrant } from "./update-command-executor-children.js";

/** Validate private store selectors before a receiver's state-backed preparation.
 * Live lease/PID admission still happens in resolveUpdateCommandChildBinding. */
export function assertUpdateCommandChildInitialStores(
  grant: UpdateCommandChildGrant | undefined,
  root: string,
  requiresInitialStores = false,
): void {
  const selectedName = grant?.childKey?.includes("-stores-v1-lineage-") === true;
  const supplied = grant !== undefined && Object.hasOwn(grant, "initialStores");
  if (
    (requiresInitialStores && !supplied) ||
    selectedName !== supplied ||
    (supplied && !grant?.initialStores)
  ) {
    throw new UpdateCommandRecoveryPendingError("Candidate initial store selection was stripped.");
  }
  if (grant?.initialStores) {
    const admission = admitUpdateInitialStoreTransport(grant.initialStores, {
      installationRoot: resolveUpdateInstallRoot(root),
      handoffPath: grant.databasePath,
      statePath: resolveOpenClawStateSqlitePath(),
    });
    admission.close();
  }
}

export function resolveUpdateCommandChildBinding(
  grant: UpdateCommandChildGrant,
  runId: string,
  root: string,
  onProcessIdentityWarning?: NonNullable<
    Parameters<typeof createManagedHandoffLeaseStore>[0]
  >["onProcessIdentityWarning"],
) {
  const slot = grant.slot;
  if (
    Object.hasOwn(grant, "slot") &&
    (!isRecord(slot) ||
      !isRecord(slot.parent) ||
      !isRecord(slot.spawner) ||
      typeof slot.parent.key !== "string" ||
      typeof slot.spawner.key !== "string" ||
      typeof slot.childKey !== "string" ||
      (Object.hasOwn(slot, "reserver") &&
        (!isRecord(slot.reserver) || typeof slot.reserver.key !== "string")))
  ) {
    throw new UpdateCommandRecoveryPendingError("Candidate occupied slot pair is malformed.");
  }
  const retainedFields =
    Object.hasOwn(grant, "retainedParent") || Object.hasOwn(grant, "retainedChildKey");
  if (
    retainedFields &&
    (!isRecord(grant.retainedParent) ||
      typeof grant.retainedParent.key !== "string" ||
      typeof grant.retainedChildKey !== "string")
  ) {
    throw new UpdateCommandRecoveryPendingError("Candidate retained owner pair is malformed.");
  }
  const original = grant.originalParent ?? grant.parent;
  const spawner = grant.spawner ?? original;
  const slotReserver = slot?.reserver;
  const slotCreator = slotReserver ?? original;
  const childPrefix = `${original.key}/.openclaw-update-child-`;
  const childName = grant.childKey.slice(
    grant.childKey.lastIndexOf("/.openclaw-update-child-") + "/.openclaw-update-child-".length,
  );
  // v2026.9.4 sent this exact private-stdin format. Pin its existing database
  // before reading/admitting the live parent and registered receiver. Modern
  // names cannot downgrade by stripping their lineage or supplied physical pin.
  const legacyGrant =
    !slot &&
    !retainedFields &&
    !grant.originalParent &&
    !grant.spawner &&
    !grant.originalChildKey &&
    !grant.databaseIdentity &&
    !Object.hasOwn(grant, "initialStores") &&
    grant.childKey === `${grant.parent.key}/.openclaw-update-child-${childName}` &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(childName);
  const databaseIdentity = legacyGrant
    ? captureManagedUpdateLeaseDatabaseIdentity(grant.databasePath)
    : grant.databaseIdentity;
  const databasePath = databaseIdentity?.databasePath ?? grant.databasePath;
  const lineageBound = Boolean(
    grant.originalParent &&
    grant.databaseIdentity &&
    grant.spawner &&
    grant.originalChildKey &&
    grant.originalChildKey === `${spawner.key}/.openclaw-update-child-${childName}` &&
    (!slot || slot.childKey === `${slot.spawner.key}/.openclaw-update-child-${childName}`) &&
    (!retainedFields ||
      grant.retainedChildKey ===
        `${grant.retainedParent!.key}/.openclaw-update-child-${childName}`) &&
    grant.childKey ===
      `${grant.parent.key === original.key ? spawner.key : grant.parent.key === slot?.parent.key ? slot.spawner.key : grant.parent.key}/.openclaw-update-child-${childName}` &&
    /^[0-9a-f-]{36}(?:-stores-v1)?-lineage-[0-9a-f]{64}$/.test(childName) &&
    childName.endsWith(
      `-lineage-${childLineageDigest(original, spawner, grant.parent, grant.databaseIdentity, grant.retainedParent, slot, grant.initialStores)}`,
    ),
  );
  const selectedFormat = childName.includes("-stores-v1-lineage-");
  if (
    (!lineageBound && !legacyGrant) ||
    (!legacyGrant && databasePath !== grant.databasePath) ||
    selectedFormat !== Object.hasOwn(grant, "initialStores") ||
    (Object.hasOwn(grant, "initialStores") && !grant.initialStores)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate store selection or lineage is missing or invalid.",
    );
  }
  const initialStoreAdmission = grant.initialStores
    ? admitUpdateInitialStoreTransport(grant.initialStores, {
        installationRoot: resolveUpdateInstallRoot(root),
        handoffPath: databasePath,
        statePath: resolveOpenClawStateSqlitePath(),
      })
    : undefined;
  const store = createManagedHandoffLeaseStore({
    databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
    existingIdentity: databaseIdentity,
    initialStoreAdmission,
    onProcessIdentityWarning,
  });
  const parent =
    grant.parent.version === 1 && grant.parent.key === resolveUpdateInstallRoot(root)
      ? {
          kind: "current" as const,
          lease: store.readLegacyParent(grant.parent.key, grant.parent.executor),
        }
      : store.read(resolveUpdateInstallRoot(root));
  const originalChild = store.read(grant.originalChildKey ?? grant.childKey);
  const child = store.read(grant.childKey);
  const slotChild = slot ? store.read(slot.childKey) : undefined;
  const retained = retainedFields ? store.read(grant.retainedParent!.key) : undefined;
  const retainedChild = retainedFields ? store.read(grant.retainedChildKey!) : undefined;
  if (
    (!lineageBound && !legacyGrant) ||
    (slot &&
      (slot.parent.key === original.key ||
        !store.current(slot.parent) ||
        slot.parent.version !== 2 ||
        slot.parent.action.kind !== "update" ||
        slot.parent.owner !== original.owner ||
        !isDeepStrictEqual(slot.parent.helper, slotCreator.executor) ||
        !isDeepStrictEqual(slot.parent.executor, slotCreator.executor) ||
        (slotReserver &&
          (!store.current(slotReserver) ||
            slotReserver.version !== 2 ||
            slotReserver.action.kind !== "update" ||
            slotReserver.owner !== runId ||
            !slotReserver.key.startsWith(childPrefix) ||
            !isDeepStrictEqual(slotReserver.helper, slotReserver.executor) ||
            (spawner.key !== slotReserver.key &&
              !spawner.key.startsWith(`${slotReserver.key}/.openclaw-update-child-`)))) ||
        !store.current(slot.spawner) ||
        slot.spawner.version !== 2 ||
        slot.spawner.action.kind !== "update" ||
        !isDeepStrictEqual(slot.spawner.executor, spawner.executor) ||
        (slot.spawner.key !== slot.parent.key &&
          (!slot.spawner.key.startsWith(`${slot.parent.key}/.openclaw-update-child-`) ||
            slot.spawner.owner !== runId)) ||
        slotChild?.kind !== "current" ||
        slotChild.lease.version !== 2 ||
        slotChild.lease.action.kind !== "update" ||
        slotChild.lease.owner !== runId ||
        !isDeepStrictEqual(slotChild.lease.helper, slot.spawner.executor))) ||
    (retainedFields &&
      (retained?.kind !== "current" ||
        !isDeepStrictEqual(retained.lease, grant.retainedParent) ||
        retained.lease.key === original.key ||
        retained.lease.action.kind !== "update" ||
        retained.lease.version === 3 ||
        !isDeepStrictEqual(retained.lease.executor, original.executor) ||
        !isDeepStrictEqual(retained.lease.helper, original.executor) ||
        retainedChild?.kind !== "current" ||
        retainedChild.lease.owner !== runId ||
        retainedChild.lease.action.kind !== "update" ||
        retainedChild.lease.version === 3 ||
        !isDeepStrictEqual(retainedChild.lease.helper, spawner.executor))) ||
    (!legacyGrant && databasePath !== grant.databasePath) ||
    grant.runId !== runId ||
    grant.root !== resolveUpdateInstallRoot(root) ||
    parent.kind !== "current" ||
    !parent.lease ||
    !isDeepStrictEqual(parent.lease, grant.parent) ||
    parent.lease.action.kind !== "update" ||
    parent.lease.version === 3 ||
    !store.current(original) ||
    original.action.kind !== "update" ||
    original.version === 3 ||
    !store.current(spawner) ||
    spawner.action.kind !== "update" ||
    spawner.version === 3 ||
    (spawner.key !== original.key &&
      (!spawner.key.startsWith(childPrefix) || spawner.owner !== runId)) ||
    process.ppid !== spawner.executor.pid ||
    !(grant.originalChildKey ?? grant.childKey).startsWith(
      `${spawner.key}/.openclaw-update-child-`,
    ) ||
    !grant.childKey.startsWith(`${parent.lease.key}/.openclaw-update-child-`) ||
    originalChild.kind !== "current" ||
    originalChild.lease.owner !== runId ||
    originalChild.lease.action.kind !== "update" ||
    originalChild.lease.version === 3 ||
    !isDeepStrictEqual(originalChild.lease.helper, spawner.executor) ||
    child.kind !== "current" ||
    child.lease.owner !== runId ||
    child.lease.action.kind !== "update" ||
    child.lease.version === 3 ||
    !isDeepStrictEqual(child.lease.helper, spawner.executor)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate executor binding does not match its parent.",
    );
  }
  return {
    original,
    spawner,
    databaseIdentity,
    databasePath,
    initialStoreAdmission,
    store,
    parent: parent.lease,
    originalChild: originalChild.lease,
    child: child.lease,
    slot,
    slotChild: slotChild?.kind === "current" ? slotChild.lease : undefined,
    retained: retained?.kind === "current" ? retained.lease : undefined,
    retainedChild: retainedChild?.kind === "current" ? retainedChild.lease : undefined,
  };
}
