import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { sha256Hex } from "../infra/crypto-digest.js";
import { withFileLock } from "../infra/file-lock.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../infra/update-managed-service-handoff-lease.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";
import { resolveTaskName } from "./schtasks-layout.js";
import type { GatewayServiceEnv, SystemdServiceReadBinding } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

type Scope = {
  active: boolean;
  pending: Set<Promise<unknown>>;
  systemdRead?: { key: string; binding: Promise<SystemdServiceReadBinding | undefined> };
};
const scopes = new AsyncLocalStorage<Map<string, Scope>>();

/** A read borrows the existing lifetime; it never creates mutation custody. */
export async function withSystemdServiceReadBinding<T>(
  env: GatewayServiceEnv,
  create: () => Promise<SystemdServiceReadBinding | undefined>,
  read: (binding: SystemdServiceReadBinding | undefined) => Promise<T>,
  deadline?: number,
): Promise<T> {
  const expired = () => new Error("Original systemd read admission deadline expired.");
  if (deadline !== undefined && performance.now() >= deadline) {
    throw expired();
  }
  const scope = scopes.getStore()?.get(resolveGatewayServiceOperationLockPath(env));
  const key = JSON.stringify([
    env.HOME,
    env.OPENCLAW_PROFILE,
    env.OPENCLAW_SYSTEMD_UNIT,
    env.OPENCLAW_STATE_DIR,
    env.XDG_RUNTIME_DIR,
    env.DBUS_SESSION_BUS_ADDRESS,
  ]);
  if (scope) {
    if (!scope.active || (scope.systemdRead && scope.systemdRead.key !== key)) {
      throw new Error("Original systemd read scope is closed or selects a different manager.");
    }
    scope.systemdRead ??= { key, binding: create() };
    const retained = scope.systemdRead.binding;
    const work = Promise.resolve().then(async () => {
      const binding = await awaitWithinDeadline(
        () => retained,
        deadline,
        () => performance.now(),
      );
      if (binding === ABSOLUTE_DEADLINE_EXPIRED) {
        throw expired();
      }
      if (!scope.active) {
        throw new Error("Original systemd read scope has closed.");
      }
      binding?.verify();
      return await read(binding);
    });
    scope.pending.add(work);
    try {
      return await work;
    } finally {
      scope.pending.delete(work);
    }
  }
  const binding = await create();
  try {
    if (deadline !== undefined && performance.now() >= deadline) {
      throw expired();
    }
    return await read(binding);
  } finally {
    await binding?.close();
  }
}

/** Serialize native effects and original-file capture using the shipped file-lock
 * owner. This lock does not attest a stopped gateway or replace native identity
 * inspection; stopped-state capture additionally holds the gateway coordinator.
 */
export async function withGatewayServiceOperationLock<T>(
  env: GatewayServiceEnv,
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  assertGatewayServiceUpdateCurrent();
  const file = resolveGatewayServiceOperationLockPath(env);
  const assertResourceUnborrowed = (targetPath: string) =>
    createManagedHandoffLeaseStore().assertSourceUnborrowed(targetPath);
  assertResourceUnborrowed(file);
  const inherited = scopes.getStore();
  const parent = inherited?.get(file);
  const assertScope = (scope: Scope) => {
    assertGatewayServiceUpdateCurrent();
    if (!scope.active) {
      throw new Error("Native service operation ownership has closed.");
    }
    // A reservation can arise inside this interval. Holding the file lock
    // remains exclusion, not permission for ordinary service mutations.
    assertResourceUnborrowed(file);
  };
  if (parent?.active) {
    let active = true;
    const work = Promise.resolve().then(() => {
      assertScope(parent);
      return operation(() => {
        assertScope(parent);
        if (!active) {
          throw new Error("Native service operation ownership has closed.");
        }
      });
    });
    parent.pending.add(work);
    try {
      return await work;
    } finally {
      active = false;
      parent.pending.delete(work);
    }
  }
  const scope: Scope = { active: false, pending: new Set() };
  const next = new Map(inherited);
  next.set(file, scope);
  return await withFileLock(
    file,
    {
      retries: { retries: 120, factor: 1.1, minTimeout: 25, maxTimeout: 250 },
      stale: 30_000,
      // Reacquire only a definitely retired process, never from age alone. The
      // provider pins the stale bytes/inode and rechecks custody before unlink.
      // This restores client exclusion, not evidence that native work completed.
      staleRecovery: "remove-if-definitely-stale",
      assertResourceUnborrowed,
    },
    async () =>
      scopes.run(next, async () => {
        scope.active = true;
        const [outcome] = await Promise.allSettled([
          Promise.resolve().then(() => {
            assertScope(scope);
            return operation(() => assertScope(scope));
          }),
        ]);
        const failures: unknown[] = [];
        // Only admitted work still pending when the outer callback settles is
        // ours to join. Preserve its failures rather than reporting a completed
        // native interval after a detached effect failed.
        while (scope.pending.size) {
          for (const result of await Promise.allSettled(scope.pending)) {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          }
        }
        // Close admission atomically with the final empty-pending observation.
        scope.active = false;
        try {
          const binding = await scope.systemdRead?.binding;
          await binding?.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          throw new AggregateError(
            outcome.status === "rejected" ? [outcome.reason, ...failures] : failures,
            "Native service operation did not settle successfully.",
          );
        }
        if (outcome.status === "rejected") {
          throw outcome.reason instanceof Error
            ? outcome.reason
            : new Error("Native service operation failed.", { cause: outcome.reason });
        }
        return outcome.value;
      }),
  );
}

function resolveGatewayServiceOperationLockPath(env: GatewayServiceEnv): string {
  const identity =
    process.platform === "darwin"
      ? `launchd:${resolveLaunchAgentGuiDomain()}/${resolveLaunchAgentLabel(env)}`
      : process.platform === "win32"
        ? `schtasks:${resolveTaskName(env).toLowerCase()}`
        : `systemd:${resolveSystemdServiceName(env)}`;
  return path.join(resolvePreferredOpenClawTmpDir(), `service-lifecycle-${sha256Hex(identity)}`);
}
