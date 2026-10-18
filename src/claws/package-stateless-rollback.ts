import { coerceErrorMessage } from "@openclaw/normalization-core";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import { resolveInstalledClawHubPlugin } from "../plugins/plugin-install-preflight.js";
import { defaultRuntime } from "../runtime.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import { readClawPackageRefsForAdd } from "./add-state-write.js";
import type { InstallClawPackagesOptions } from "./package-install-options.js";
import type { PersistedClawPackageRef } from "./provenance.js";

type RollbackOptions = Pick<
  InstallClawPackagesOptions,
  "assertCurrent" | "env" | "path" | "runtime"
>;

/** Undo only plugin installs made by this in-flight Add, before its agent is published. */
export async function rollbackStatelessClawPackagesWithStamps(
  packages: PersistedClawPackageRef[],
  options: RollbackOptions,
  stamps: WeakMap<PersistedClawPackageRef, { pluginId: string; installedAt: string }>,
): Promise<string[]> {
  const errors: string[] = [];
  const runtime = options.runtime ?? defaultRuntime;
  for (const pkg of packages.toReversed()) {
    if (pkg.kind !== "plugin" || pkg.origin !== "claw-introduced") {
      continue;
    }
    const stamp = stamps.get(pkg);
    if (!stamp) {
      continue;
    }
    let lease: MaintainedClawPackageLifecycleLease | null = null;
    try {
      const acquired = await acquireClawPackageLifecycleLease(
        { kind: "plugin", source: "clawhub", ref: pkg.ref },
        { env: options.env, path: options.path, required: true },
      );
      if (!acquired) {
        throw new Error(`Could not acquire package lifecycle lease for ${pkg.ref}.`);
      }
      lease = maintainClawPackageLifecycleLease(acquired);
      const owners = await readClawPackageRefsForAdd({
        ...options,
        kind: "plugin",
        source: "clawhub",
        ref: pkg.ref,
        version: pkg.version,
        integrity: pkg.integrity,
      });
      if (owners.some((owner) => owner.status === "pending" || owner.status === "complete")) {
        continue;
      }
      const installed = await resolveInstalledClawHubPlugin({ clawhubPackage: pkg.ref });
      if (
        installed.status !== "found" ||
        installed.pluginId !== stamp.pluginId ||
        installed.record.installedAt !== stamp.installedAt ||
        installed.installedVersion !== pkg.version ||
        !installed.record.integrity ||
        normalizeClawHubSha256Integrity(installed.record.integrity) !==
          normalizeClawHubSha256Integrity(pkg.integrity)
      ) {
        continue;
      }
      const activeLease = lease;
      // The Add batch may be closed; CLI uninstall schedules its own runtime restart.
      const params: Parameters<typeof uninstallPluginWithPolicy>[0] = {
        pluginId: installed.pluginId,
        caller: "cli",
        invalidateRuntimeCache: false,
        clawManaged: true,
        beforePersistentApply: () => {
          activeLease.assertCurrent();
          options.assertCurrent?.();
        },
        onWarning: (warning) => runtime.log(warning),
      };
      options.assertCurrent?.();
      const removed = await uninstallPluginWithPolicy(params);
      if (!removed.ok) {
        throw new Error(removed.error);
      }
      pkg.status = "rolled_back";
    } catch (error) {
      errors.push(`plugin ${pkg.ref} cleanup failed: ${coerceErrorMessage(error)}`);
    } finally {
      try {
        await lease?.release();
      } catch (error) {
        errors.push(`plugin ${pkg.ref} cleanup lease failed: ${coerceErrorMessage(error)}`);
      }
    }
  }
  return errors;
}
