/** systemd start, stop, restart, and obsolete-unit removal. */
import fs from "node:fs/promises";
import { hasErrnoCode } from "../infra/errno.js";
import { LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES } from "./constants.js";
import { formatLine } from "./output.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  SystemdServiceReadTarget,
} from "./service-types.js";
import {
  assertSystemdAvailable,
  disableSystemdUserUnitForRemoval,
  execSystemctl,
  execSystemctlUser,
  isSystemctlAvailable,
  reloadSystemdUserManager,
} from "./systemd-exec.js";
import {
  assertNoSystemGatewayOwnershipForActivation,
  findInstalledSystemdGatewayScope,
} from "./systemd-scope.js";
import {
  resolveSystemdServiceName,
  resolveSystemdUnitPath,
  resolveSystemdUnitPathForName,
} from "./systemd-service-files.js";
import { activateSystemdServiceIdentity } from "./systemd-service-identity.js";
import { isRunningAsRoot } from "./systemd-system.js";

async function runSystemdServiceAction(
  params: GatewayServiceControlArgs,
  action: "start" | "stop" | "restart",
) {
  const env = params.env ?? process.env;
  const label = { start: "Started", stop: "Stopped", restart: "Restarted" }[action];
  const reportMutation = createGatewayLifecycleMutationReporter(params.onMutation);
  const report = (unitName: string) => {
    reportMutation(`systemctl-${action}`);
    params.stdout.write(`${formatLine(`${label} systemd service`, unitName)}\n`);
  };
  if (params.systemdIdentity && action !== "stop") {
    if (params.systemdIdentity.scope === "user") {
      const scopedEnv = { ...env, OPENCLAW_SYSTEMD_UNIT: params.systemdIdentity.unitName };
      await assertNoSystemGatewayOwnershipForActivation(scopedEnv);
    }
    if (params.systemdIdentity.scope === "system" && !isRunningAsRoot()) {
      throw new Error(
        `${params.systemdIdentity.unitName} is a system-scope unit (${params.systemdIdentity.unitPath}); run \`sudo systemctl ${action} ${params.systemdIdentity.unitName}\` to ${action} it`,
      );
    }
    await activateSystemdServiceIdentity({
      identity: params.systemdIdentity,
      action,
      assertCurrent: params.assertCurrent,
      warn:
        params.warn ??
        ((message) => {
          params.stdout.write(`${formatLine("Warning", message)}\n`);
        }),
    });
    report(params.systemdIdentity.unitName);
    return;
  }
  const installed = await findInstalledSystemdGatewayScope(env);
  const unitName = installed?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  let runSystemctl: (args: string[]) => ReturnType<typeof execSystemctl>;
  if (installed?.scope === "system") {
    if (!isRunningAsRoot()) {
      throw new Error(
        `${unitName} is a system-scope unit (${installed.unitPath}); run \`sudo systemctl ${action} ${unitName}\` to ${action} it`,
      );
    }
    runSystemctl = (args) => {
      params.assertCurrent?.();
      return execSystemctl(args, env);
    };
  } else {
    await assertSystemdAvailable(env);
    if (action !== "stop") {
      const scopedEnv = { ...env, OPENCLAW_SYSTEMD_UNIT: unitName };
      await assertNoSystemGatewayOwnershipForActivation(scopedEnv);
    }
    runSystemctl = (args) => execSystemctlUser(env, args, undefined, params.assertCurrent);
  }
  if (action !== "stop") {
    // Clear crash-loop start-limit latches only after scope ownership is proven;
    // otherwise resetting a conflicting manager could mutate the wrong service.
    params.assertCurrent?.();
    await runSystemctl(["reset-failed", unitName]);
  }
  params.assertCurrent?.();
  if (action === "restart") {
    params.onRestartAttempted?.();
  }
  const res = await runSystemctl([action, unitName]);
  if (res.code !== 0) {
    throw new Error(`systemctl ${action} failed: ${res.stderr || res.stdout}`.trim());
  }
  report(unitName);
}

export async function startSystemdService(args: GatewayServiceControlArgs): Promise<void> {
  await runSystemdServiceAction(args, "start");
}

export async function stopSystemdService(args: GatewayServiceControlArgs): Promise<void> {
  await runSystemdServiceAction(args, "stop");
}

export async function restartSystemdService(
  args: GatewayServiceControlArgs,
): Promise<GatewayServiceRestartResult> {
  await runSystemdServiceAction(args, "restart");
  return { outcome: "completed" };
}

type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function removeSystemdUnitBackup(unitPath: string): Promise<void> {
  try {
    await fs.unlink(`${unitPath}.bak`);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function findLegacySystemdUnits(env: GatewayServiceEnv): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isSystemctlAvailable(env);
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let backupExists = false;
    try {
      await fs.access(`${unitPath}.bak`);
      backupExists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await execSystemctlUser(env, ["is-enabled", `${name}.service`]);
      enabled = res.code === 0;
    }
    if (exists || backupExists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) {
    return units;
  }

  const systemctlAvailable = await isSystemctlAvailable(env);
  let removedAny = false;
  for (const unit of units) {
    if (systemctlAvailable) {
      await disableSystemdUserUnitForRemoval(env, `${unit.name}.service`);
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      removedAny = true;
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
    await removeSystemdUnitBackup(unit.unitPath);
  }
  if (systemctlAvailable && removedAny) {
    await reloadSystemdUserManager(env);
  }

  return units;
}

type UninstallUserSystemdGatewayUnitResult = {
  unitName: string;
  unitPath: string;
  removed: boolean;
  /**
   * False when systemctl could not disable/stop the unit. Deleting the unit
   * file alone does not evict an already-loaded unit, so callers must not
   * claim the conflict is resolved on a file-only removal.
   */
  disabled: boolean;
};

/**
 * Removes the canonical *user-scope* gateway unit, leaving any system-scope
 * unit untouched. Used by doctor to resolve a `dueling` installation by
 * dropping the redundant user-scope leftover (issue #79375). Removing a unit
 * under `$HOME` needs no root, unlike the system-scope unit.
 *
 * Pass the inspected user unit as `target` after confirmation. A later lookup
 * must not fall back to a leftover legacy unit if that confirmed file vanished.
 */
export async function uninstallUserSystemdGatewayUnit({
  env,
  stdout,
  target,
}: GatewayServiceManageArgs & {
  target?: SystemdServiceReadTarget;
}): Promise<UninstallUserSystemdGatewayUnitResult> {
  const installed = await findInstalledSystemdGatewayScope(env);
  if (target) {
    if (target.scope !== "user") {
      throw new Error(
        `Confirmed systemd unit ${target.unitName} is ${target.scope}-scope; refusing user-scope cleanup`,
      );
    }
    if (
      installed?.scope === "user" &&
      (installed.unitName !== target.unitName || installed.unitPath !== target.unitPath)
    ) {
      throw new Error(
        `Confirmed user systemd unit ${target.unitName} changed to ${installed.unitName}; refusing cleanup`,
      );
    }
  }
  const unitName =
    target?.unitName ??
    (installed?.scope === "user"
      ? installed.unitName
      : `${resolveSystemdServiceName(env)}.service`);
  const unitPath =
    target?.unitPath ??
    (installed?.scope === "user" ? installed.unitPath : resolveSystemdUnitPath(env));
  let disabled = false;
  if (await isSystemctlAvailable(env)) {
    await disableSystemdUserUnitForRemoval(env, unitName);
    disabled = true;
  } else {
    stdout.write(
      `systemctl unavailable; removing unit file only: ${unitName}. A loaded unit keeps running until systemd reloads.\n`,
    );
  }
  let removed = false;
  try {
    await fs.unlink(unitPath);
    removed = true;
    stdout.write(`${formatLine("Removed user-scope systemd service", unitPath)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    stdout.write(`User-scope systemd unit not found at ${unitPath}\n`);
  }
  await removeSystemdUnitBackup(unitPath);
  // The manager keeps a deleted unit's definition loaded until it reloads, so
  // without this the unit stays startable while the detector reports it gone.
  if (removed && disabled) {
    await reloadSystemdUserManager(env);
  }
  return { unitName, unitPath, removed, disabled };
}
