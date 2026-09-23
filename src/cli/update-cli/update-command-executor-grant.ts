import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
  type ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
import {
  childLineageDigest,
  type UpdateCommandChildGrant,
} from "./update-command-executor-children.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
export type { UpdateCommandChildGrant } from "./update-command-executor-children.js";

export function resolveUpdateCommandChildBinding(
  grant: UpdateCommandChildGrant,
  runId: string,
  root: string,
  onProcessIdentityWarning?: NonNullable<
    Parameters<typeof createManagedHandoffLeaseStore>[0]
  >["onProcessIdentityWarning"],
) {
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
  const childPrefix = `${original.key}/.openclaw-update-child-`;
  const childName = grant.childKey.slice(
    grant.childKey.lastIndexOf("/.openclaw-update-child-") + "/.openclaw-update-child-".length,
  );
  // v2026.9.4 sent this exact private-stdin format. Pin its existing database
  // before reading/admitting the live parent and registered receiver. Modern
  // names cannot downgrade by stripping their lineage or supplied physical pin.
  const legacyGrant =
    !retainedFields &&
    !grant.originalParent &&
    !grant.spawner &&
    !grant.originalChildKey &&
    !grant.databaseIdentity &&
    grant.childKey === `${grant.parent.key}/.openclaw-update-child-${childName}` &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(childName);
  const databaseIdentity = legacyGrant
    ? captureManagedUpdateLeaseDatabaseIdentity(grant.databasePath)
    : grant.databaseIdentity;
  const databasePath = databaseIdentity?.databasePath ?? grant.databasePath;
  const store = createManagedHandoffLeaseStore({
    databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
    existingIdentity: databaseIdentity,
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
  const retained = retainedFields ? store.read(grant.retainedParent!.key) : undefined;
  const retainedChild = retainedFields ? store.read(grant.retainedChildKey!) : undefined;
  const lineageBound = Boolean(
    grant.originalParent &&
    grant.databaseIdentity &&
    grant.spawner &&
    grant.originalChildKey &&
    grant.originalChildKey === `${spawner.key}/.openclaw-update-child-${childName}` &&
    (!retainedFields ||
      grant.retainedChildKey ===
        `${grant.retainedParent!.key}/.openclaw-update-child-${childName}`) &&
    grant.childKey ===
      `${grant.parent.key === original.key ? spawner.key : grant.parent.key}/.openclaw-update-child-${childName}` &&
    /^[0-9a-f-]{36}-lineage-[0-9a-f]{64}$/.test(childName) &&
    childName.endsWith(
      `-lineage-${childLineageDigest(original, spawner, grant.parent, grant.databaseIdentity, grant.retainedParent)}`,
    ),
  );
  if (
    (!lineageBound && !legacyGrant) ||
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
    store,
    parent: parent.lease,
    originalChild: originalChild.lease,
    child: child.lease,
    retained: retained?.kind === "current" ? retained.lease : undefined,
    retainedChild: retainedChild?.kind === "current" ? retainedChild.lease : undefined,
  };
}

/** Recheck the admitted lineage without imposing the caller's operation deadline. */
export function assertUpdateCommandChildBindingCurrent(
  binding: ReturnType<typeof resolveUpdateCommandChildBinding>,
): void {
  const { original, parent, spawner, originalChild, child, retained, retainedChild, store } =
    binding;
  const isLive = (identity: ManagedHandoffLease["executor"]) =>
    store.isProcessIdentityCurrent(identity);
  // Several lineage roles can name the same full lease. Share only this
  // assertion's successful checks; every later assertion reads live state.
  const checkedParents: ManagedHandoffParent[] = [];
  const checkedReceivers: ManagedHandoffLease[] = [];
  const parentIsCurrent = (lease: ManagedHandoffParent) => {
    if (checkedParents.some((checked) => isDeepStrictEqual(checked, lease))) {
      return true;
    }
    if (!store.current(lease) || !isLive(lease.helper) || !isLive(lease.executor)) {
      return false;
    }
    checkedParents.push(lease);
    return true;
  };
  const receiverIsCurrent = (lease: ManagedHandoffLease) => {
    if (checkedReceivers.some((checked) => isDeepStrictEqual(checked, lease))) {
      return true;
    }
    if (!store.owns(lease, "executor")) {
      return false;
    }
    checkedReceivers.push(lease);
    return true;
  };
  if (
    !parentIsCurrent(original) ||
    !parentIsCurrent(parent) ||
    !parentIsCurrent(spawner) ||
    !receiverIsCurrent(originalChild) ||
    !receiverIsCurrent(child) ||
    (retained &&
      (!retainedChild || !parentIsCurrent(retained) || !receiverIsCurrent(retainedChild)))
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "The update process no longer has permission to continue.",
    );
  }
}
