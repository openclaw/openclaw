import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { ManagedCommandProcessAuthority } from "../../infra/update-managed-command-custody.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import {
  prepareManagedHandoffLeaseStore,
  type ManagedHandoffLease,
  type ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import {
  childLineageDigest,
  createChildOwner,
  type UpdateCommandChildGrant,
} from "./update-command-executor-children.js";
import {
  prepareUpdateCommandExecutorTerminal,
  withUpdateCommandExecutorOperation,
} from "./update-command-executor-operation.js";
import {
  admittedAuthorities,
  slotReservations,
  occupiedSlotKey,
  childOwners,
  terminalPreparations,
} from "./update-command-executor-state.js";
import { createUpdateIdentityWarningReporter } from "./update-command-identity-warning.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

function memoizeSuccessfulLeaseCheck<T>(check: (lease: T) => boolean) {
  const checked: T[] = [];
  return (lease: T) => {
    if (checked.some((previous) => isDeepStrictEqual(previous, lease))) {
      return true;
    }
    if (!check(lease)) {
      return false;
    }
    checked.push(lease);
    return true;
  };
}

/** A delegated executor retains both its original root and immediate spawner.
 * Neither the transported grant nor a lease row without live identity grants effects. */
export async function withDelegatedUpdateCommandExecutor<T>(
  grant: UpdateCommandChildGrant,
  runId: string,
  root: string,
  operation: (
    fence: UpdateRecoveryFence,
    commandAuthority: ManagedCommandProcessAuthority,
  ) => Promise<T>,
  options?: { activationTimeoutMs: number },
): Promise<T> {
  const activation = createUpdateOperationDeadline();
  return await activation.run(() =>
    withCommandProcessScope(async () => {
      const identityWarnings = createUpdateIdentityWarningReporter(runId);
      const onProcessIdentityWarning = identityWarnings.warn;
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
        grant.childKey === `${grant.parent.key}/.openclaw-update-child-${childName}` &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(childName);
      let databaseIdentity = legacyGrant
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
        /^[0-9a-f-]{36}-lineage-[0-9a-f]{64}$/.test(childName) &&
        childName.endsWith(
          `-lineage-${childLineageDigest(original, spawner, grant.parent, grant.databaseIdentity, grant.retainedParent, slot)}`,
        ),
      );
      if (
        (!lineageBound && !legacyGrant) ||
        (!legacyGrant && databasePath !== grant.databasePath)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Candidate executor lineage is missing or invalid.",
        );
      }
      // Lineage authenticates the original bytes before legacy pins are normalized.
      // Bound descendants differ from self-owned, bare-UUID legacy bridges; only
      // the initial hop from an older original or its bridge can need rounding.
      databaseIdentity = captureManagedUpdateLeaseDatabaseIdentity(
        databasePath,
        databaseIdentity,
        (spawner.key === original.key ||
          (spawner.key.startsWith(childPrefix) &&
            isDeepStrictEqual(spawner.helper, spawner.executor) &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              spawner.key.slice(childPrefix.length),
            ))) &&
          original.action.kind === "update" &&
          (original.version === 1 ||
            (original.version === 2 && original.action.mutationProtocol === undefined)),
      );
      const store = await prepareManagedHandoffLeaseStore({
        databasePath,
        serviceManagerEnv: resolveServiceManagerEnv(),
        existingIdentity: databaseIdentity,
        onProcessIdentityWarning,
      });
      const parentRead =
        grant.parent.version === 1 && grant.parent.key === resolveUpdateInstallRoot(root)
          ? {
              kind: "current" as const,
              lease: store.readLegacyParent(grant.parent.key, grant.parent.executor),
            }
          : store.read(resolveUpdateInstallRoot(root));
      const originalChildRead = store.read(grant.originalChildKey ?? grant.childKey);
      const childRead = store.read(grant.childKey);
      const slotChildRead = slot ? store.read(slot.childKey) : undefined;
      const retainedRead = retainedFields ? store.read(grant.retainedParent!.key) : undefined;
      const retainedChildRead = retainedFields ? store.read(grant.retainedChildKey!) : undefined;
      const bindingParentIsCurrent = (lease: typeof original, version?: 2) =>
        store.current(lease) &&
        (version === 2
          ? lease.version === 2 && lease.action.kind === "update"
          : lease.action.kind === "update" && lease.version !== 3);
      const bindingChildIsCurrent = (
        observed: ReturnType<typeof store.read> | undefined,
        helper: typeof spawner.executor,
        version?: 2,
      ): observed is Extract<ReturnType<typeof store.read>, { kind: "current" }> =>
        observed?.kind === "current" &&
        observed.lease.owner === runId &&
        observed.lease.action.kind === "update" &&
        (version === 2 ? observed.lease.version === 2 : observed.lease.version !== 3) &&
        isDeepStrictEqual(observed.lease.helper, helper);
      for (const read of [
        parentRead,
        originalChildRead,
        childRead,
        slotChildRead,
        retainedRead,
        retainedChildRead,
      ]) {
        if (read?.kind === "unreadable") {
          throw new UpdateCommandRecoveryPendingError(
            `Candidate executor lease is unreadable: ${formatErrorMessage(read.error)}`,
            { cause: read.error },
          );
        }
      }
      if (
        (slot &&
          (slot.parent.key === original.key ||
            !bindingParentIsCurrent(slot.parent, 2) ||
            slot.parent.owner !== original.owner ||
            !isDeepStrictEqual(slot.parent.helper, slotCreator.executor) ||
            !isDeepStrictEqual(slot.parent.executor, slotCreator.executor) ||
            (slotReserver &&
              (!bindingParentIsCurrent(slotReserver, 2) ||
                slotReserver.owner !== runId ||
                !slotReserver.key.startsWith(childPrefix) ||
                !isDeepStrictEqual(slotReserver.helper, slotReserver.executor) ||
                (spawner.key !== slotReserver.key &&
                  !spawner.key.startsWith(`${slotReserver.key}/.openclaw-update-child-`)))) ||
            !bindingParentIsCurrent(slot.spawner, 2) ||
            !isDeepStrictEqual(slot.spawner.executor, spawner.executor) ||
            (slot.spawner.key !== slot.parent.key &&
              (!slot.spawner.key.startsWith(`${slot.parent.key}/.openclaw-update-child-`) ||
                slot.spawner.owner !== runId)) ||
            !bindingChildIsCurrent(slotChildRead, slot.spawner.executor, 2))) ||
        (retainedFields &&
          (retainedRead?.kind !== "current" ||
            !isDeepStrictEqual(retainedRead.lease, grant.retainedParent) ||
            retainedRead.lease.key === original.key ||
            retainedRead.lease.action.kind !== "update" ||
            retainedRead.lease.version === 3 ||
            !isDeepStrictEqual(retainedRead.lease.executor, original.executor) ||
            !isDeepStrictEqual(retainedRead.lease.helper, original.executor) ||
            !bindingChildIsCurrent(retainedChildRead, spawner.executor))) ||
        (!legacyGrant && databasePath !== grant.databasePath) ||
        grant.runId !== runId ||
        grant.root !== resolveUpdateInstallRoot(root) ||
        parentRead.kind !== "current" ||
        !parentRead.lease ||
        !isDeepStrictEqual(parentRead.lease, grant.parent) ||
        parentRead.lease.action.kind !== "update" ||
        parentRead.lease.version === 3 ||
        !bindingParentIsCurrent(original) ||
        !bindingParentIsCurrent(spawner) ||
        (spawner.key !== original.key &&
          (!spawner.key.startsWith(childPrefix) || spawner.owner !== runId)) ||
        (process.platform !== "win32" && process.ppid !== spawner.executor.pid) ||
        !(grant.originalChildKey ?? grant.childKey).startsWith(
          `${spawner.key}/.openclaw-update-child-`,
        ) ||
        !grant.childKey.startsWith(`${parentRead.lease.key}/.openclaw-update-child-`) ||
        !bindingChildIsCurrent(originalChildRead, spawner.executor) ||
        !bindingChildIsCurrent(childRead, spawner.executor)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Candidate executor binding does not match its parent.",
        );
      }
      const parent = parentRead.lease;
      const originalChild = originalChildRead.lease;
      const child = childRead.lease;
      const slotChild = slotChildRead?.kind === "current" ? slotChildRead.lease : undefined;
      const retained = retainedRead?.kind === "current" ? retainedRead.lease : undefined;
      const retainedChild =
        retainedChildRead?.kind === "current" ? retainedChildRead.lease : undefined;
      using readConnections = new DisposableStack();
      readConnections.use(store.retainReadConnection());
      let active = true;
      const isLive = (identity: ManagedHandoffLease["executor"]) =>
        store.isProcessIdentityCurrent(identity);
      const receivers = [
        originalChild,
        child,
        ...(slotChild ? [slotChild] : []),
        ...(retainedChild ? [retainedChild] : []),
      ];
      // Windows launcher ancestry can differ from the recorded spawner. The live
      // lease must still bind this PID and start identity; only an immediate
      // parent may supply the existing fallback for an unreadable self identity.
      if (
        !receivers.every(
          (lease) =>
            (process.platform === "win32" && store.owns(lease, "executor")) ||
            store.acceptParentBoundExecutor(lease),
        )
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "The update process no longer has permission to continue.",
        );
      }
      const assertBase = () => {
        if (active || activation.failure) {
          activation.assertCurrent();
        }
        // Several lineage roles can name the same full lease. Share only this
        // assertion's successful checks; every later assertion reads live state.
        const parentIsCurrent = memoizeSuccessfulLeaseCheck(
          (lease: ManagedHandoffParent) =>
            store.current(lease) && isLive(lease.helper) && isLive(lease.executor),
        );
        const receiverIsCurrent = memoizeSuccessfulLeaseCheck((lease: ManagedHandoffLease) =>
          store.owns(lease, "executor"),
        );
        if (
          !active ||
          !parentIsCurrent(original) ||
          !parentIsCurrent(parent) ||
          !parentIsCurrent(spawner) ||
          !receiverIsCurrent(originalChild) ||
          !receiverIsCurrent(child) ||
          (slot &&
            (!slotChild ||
              !parentIsCurrent(slot.parent) ||
              !parentIsCurrent(slot.spawner) ||
              (slot.reserver && !parentIsCurrent(slot.reserver)) ||
              !receiverIsCurrent(slotChild))) ||
          (retained &&
            (!retainedChild || !parentIsCurrent(retained) || !receiverIsCurrent(retainedChild)))
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "The update process no longer has permission to continue.",
          );
        }
      };
      const owner = createChildOwner({
        runId,
        binding: () => ({
          store,
          parent,
          original,
          spawner: originalChild,
          ...(slot && slotChild
            ? {
                slot: {
                  parent: slot.parent,
                  spawner: slotChild,
                  ...(slot.reserver ? { reserver: slot.reserver } : {}),
                },
              }
            : {}),
          ...(retained ? { retainedParent: retained } : {}),
          databasePath,
          databaseIdentity,
        }),
        assertBase,
      });
      activation.signal.addEventListener("abort", () => owner.close(), { once: true });
      const fence = {
        assertCurrent() {
          assertBase();
          owner.assertIdle();
        },
      };
      slotReservations.set(fence, (slotRoot) => {
        fence.assertCurrent();
        if (path.resolve(slotRoot) === original.key) {
          return;
        }
        const key = occupiedSlotKey(slotRoot);
        if (key !== original.key && key !== slot?.parent.key) {
          throw new UpdateCommandRecoveryPendingError(
            "Candidate cannot reserve an ungranted installation slot.",
          );
        }
      });
      const meta = await readControlPlaneUpdateSentinelMeta();
      assertBase();
      const managedHandoff =
        original.version !== 1 &&
        original.helper.pid !== original.executor.pid &&
        meta?.runId === runId &&
        meta.handoffId === original.owner &&
        meta.root !== undefined &&
        [original.key, parent.key].includes(resolveUpdateInstallRoot(meta.root));
      childOwners.set(fence, (childRoot, childOperation, purpose) =>
        owner.run(childRoot, childOperation, purpose),
      );
      try {
        const operationOutcome = await withUpdateCommandExecutorOperation(
          {
            children: owner,
            operation: () => {
              fence.assertCurrent();
              admittedAuthorities.set(fence, {
                authority: Object.freeze({
                  ...databaseIdentity,
                  installKey: original.key,
                  owner: original.owner,
                }),
                assertCurrent: assertBase,
                managedHandoff,
                runId,
                retainedRoot: retained?.key,
              });
              if (options) {
                activation.start(
                  new UpdateActivationTimeoutError(root, options.activationTimeoutMs),
                  options.activationTimeoutMs,
                );
              }
              return operation(fence, {
                runId,
                databaseIdentity,
                parents: [
                  originalChild,
                  child,
                  ...(retainedChild ? [retainedChild] : []),
                  ...(slotChild ? [slotChild] : []),
                ],
              });
            },
          },
          "delegated",
        ).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        const outcome = await prepareUpdateCommandExecutorTerminal(fence, operationOutcome);
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.result;
      } finally {
        identityWarnings.flush();
        active = false;
        childOwners.delete(fence);
        slotReservations.delete(fence);
        admittedAuthorities.delete(fence);
        terminalPreparations.delete(fence);
      }
    }, activation.signal),
  );
}
