import { isPidAlive } from "../shared/pid-alive.js";
import type { GatewayRestartIntent } from "./restart-intent.js";
import { readControlPlaneUpdateSentinelMeta } from "./update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { waitForHandoffResponse } from "./update-managed-service-handoff-control.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import type { ActiveManagedServiceUpdateHandoff } from "./update-managed-service-handoff-types.js";
import type { ManagedHandoffParentStore } from "./update-managed-service-handoff-worker.js";

export const activeManagedServiceUpdateHandoffs = new Map<
  string,
  ActiveManagedServiceUpdateHandoff
>();

/** A detached helper still shares the system unit's cgroup until it settles. */
export function waitForSystemServiceUpdateHandoffs(): Promise<void> | undefined {
  const updates = [...activeManagedServiceUpdateHandoffs.values()].filter(
    (owner) => owner.operatorRestartWarning && !owner.settled,
  );
  if (!updates.length) {
    return undefined;
  }
  return (async () => {
    await Promise.all(
      updates.map(async (owner) => {
        await owner.flight;
        await owner.closed;
        if (!owner.settled) {
          throw new Error("System-service updater settlement could not be confirmed.");
        }
      }),
    );
  })();
}

/** A transferred updater may manage its serving ancestor only under its current lease. */
export async function isCurrentManagedServiceUpdateHandoffProcess(params: {
  root: string;
  runId: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Retain the executor's admitted physical store through the sentinel await. */
  store?: ReturnType<typeof createManagedHandoffLeaseStore>;
}): Promise<boolean> {
  const env = params.env ?? process.env;
  if (env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1" || !params.runId) {
    return false;
  }
  const meta = await readControlPlaneUpdateSentinelMeta(env);
  const root = resolveUpdateInstallRoot(params.root);
  if (
    meta?.runId !== params.runId ||
    !meta.handoffId ||
    !meta.root ||
    resolveUpdateInstallRoot(meta.root) !== root
  ) {
    return false;
  }
  const lease = await readManagedServiceUpdateHandoffLease(root, undefined, params.store);
  const store = params.store ?? createManagedHandoffLeaseStore();
  return (
    lease?.owner === meta.handoffId &&
    lease.executor.pid === process.pid &&
    (store.isProcessIdentityCurrent(lease.executor) ||
      (process.connected && store.acceptParentBoundExecutor(lease)))
  );
}

export async function readManagedServiceUpdateHandoffLease(
  root: string,
  stale?: ActiveManagedServiceUpdateHandoff,
  selectedStore?: ReturnType<typeof createManagedHandoffLeaseStore> | ManagedHandoffParentStore,
): Promise<ManagedHandoffLease | null | undefined> {
  const owner = stale ?? activeManagedServiceUpdateHandoffs.get(root);
  const store = selectedStore ?? (owner ? owner.leaseStore : createManagedHandoffLeaseStore());
  const result = await store?.read(root);
  if (!store || result?.kind !== "current") {
    return result?.kind === "absent" ? null : undefined;
  }
  const lease = result.lease;
  if (
    stale?.handoffId === lease.owner &&
    JSON.stringify(stale.helper?.helper) === JSON.stringify(lease.helper) &&
    (lease.action.kind !== "update" || stale.helper?.payload === lease.payload) &&
    (lease.action.kind !== "triage" ||
      (stale.helper?.action.kind === "triage" &&
        JSON.stringify(stale.helper.action.lifetime) === JSON.stringify(lease.action.lifetime))) &&
    (await store.release(lease))
  ) {
    return null;
  }
  return lease;
}

/** Called only before activation; later admission consumes the live helper's joined park fact. */
export function isForegroundUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): boolean {
  const owner = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  );
  return owner?.handoffId === identity.handoffId && owner.foregroundOrigin !== undefined;
}

export async function claimManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<boolean> {
  const active = await currentManagedServiceUpdateHandoff(identity);
  if (!active || active.cancelling) {
    return false;
  }
  active.claimed = true;
  return true;
}

export async function currentManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<ActiveManagedServiceUpdateHandoff | undefined> {
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  const launcher = active?.launcher;
  const helper = active?.helper;
  if (!active) {
    return undefined;
  }
  const lease = await readManagedServiceUpdateHandoffLease(root);
  if (
    identity.kind !== "managed-update-handoff" ||
    active?.handoffId !== identity.handoffId ||
    !active.leaseStore ||
    !launcher?.pid ||
    !isPidAlive(launcher.pid) ||
    active.launcherStartIdentity == null ||
    !(await active.leaseStore.isProcessIdentityCurrent(
      { pid: launcher.pid, startIdentity: active.launcherStartIdentity },
      launcher.exitCode === null && launcher.signalCode === null,
    )) ||
    launcher.exitCode !== null ||
    launcher.signalCode !== null ||
    lease?.owner !== identity.handoffId ||
    helper?.owner !== identity.handoffId ||
    (!(active.transferred && helper.action.kind === "update") &&
      (lease.executor.pid !== helper.executor.pid ||
        lease.executor.startIdentity !== helper.executor.startIdentity)) ||
    JSON.stringify(lease.helper) !== JSON.stringify(helper.helper) ||
    JSON.stringify(lease.action) !== JSON.stringify(helper.action) ||
    (lease.action.kind === "triage" && lease.action.phase !== "reserved") ||
    !isPidAlive(lease.executor.pid) ||
    !(await active.leaseStore.isProcessIdentityCurrent(
      lease.executor,
      lease.executor.pid === launcher.pid &&
        launcher.exitCode === null &&
        launcher.signalCode === null,
    )) ||
    activeManagedServiceUpdateHandoffs.get(root) !== active ||
    launcher.exitCode !== null ||
    launcher.signalCode !== null
  ) {
    return undefined;
  }
  return active;
}

export type ForegroundUpdateStop = {
  settle: () => Promise<boolean>;
  canPark: (identity: NonNullable<GatewayRestartIntent["successorOwner"]>) => boolean;
};

/** Retain exact owners so a later Stop can reconcile previously uncertain settlement. */
export function captureForegroundUpdateHandoffStop(params: {
  onPark: (identity: NonNullable<GatewayRestartIntent["successorOwner"]>) => void;
}): ForegroundUpdateStop | undefined {
  const owners = [...activeManagedServiceUpdateHandoffs].filter(
    ([, owner]) => owner.foregroundOrigin?.pid === process.pid,
  );
  if (!owners.length) {
    return undefined;
  }
  const canPark: ForegroundUpdateStop["canPark"] = (identity) =>
    // Signal admission is local; actual parking and terminal commit await the lease claim.
    owners.some(
      ([root, owner]) =>
        owner.parkReady &&
        owner.handoffId === identity.handoffId &&
        root === resolveUpdateInstallRoot(identity.installRoot) &&
        activeManagedServiceUpdateHandoffs.get(root) === owner &&
        !owner.cancelling &&
        owner.launcher?.exitCode === null &&
        owner.launcher.signalCode === null,
    );
  return {
    canPark,
    settle: async () => {
      // Settlement retains the lease worker while cancellation joins the same helper.
      for (const [root, owner] of owners) {
        const identity = {
          kind: "managed-update-handoff" as const,
          installRoot: root,
          handoffId: owner.handoffId,
        };
        owner.closeForStop = () => {
          if (canPark(identity)) {
            params.onPark(identity);
          }
        };
        owner.closeForStop();
      }
      const settled = await Promise.allSettled(
        owners.map(async ([root, owner]) => {
          // A failed launch can still own a child or lease; neither is inferred absent.
          await owner.flight?.catch(() => {});
          await owner.closed;
          const child = owner.launcher;
          if (
            child &&
            ((child.pid && child.exitCode === null && child.signalCode === null) ||
              (await readManagedServiceUpdateHandoffLease(root, owner)) !== null)
          ) {
            return false;
          }
          if (!owner.parkReady && activeManagedServiceUpdateHandoffs.get(root) === owner) {
            activeManagedServiceUpdateHandoffs.delete(root);
          }
          return true;
        }),
      );
      if (!settled.every((result) => result.status === "fulfilled" && result.value)) {
        return false;
      }
      // A retry still reads every captured owner, including already settled siblings.
      for (const [root, owner] of owners) {
        if (activeManagedServiceUpdateHandoffs.get(root) !== owner) {
          await owner.leaseStore?.close();
        }
        delete owner.closeForStop;
      }
      return true;
    },
  };
}

/** Request one control step from the active helper; a missing or closed helper answers null. */
export function sendManagedServiceUpdateHandoffCommand(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  command: string,
): Promise<string | null> {
  const owner = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  );
  const child = owner?.launcher;
  if (!owner || !child?.stdin || !child.stdout || child.stdin.destroyed) {
    return Promise.resolve(null);
  }
  return waitForHandoffResponse(
    child,
    command === "park" ? owner.parentExitTimeoutMs : owner.recoveryTimeoutMs,
    command,
  ).catch(() => null);
}
