import fs from "node:fs/promises";
import path from "node:path";
import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { UpdatePreMutationError } from "../cli/update-cli/shared.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../daemon/launchd-label.js";
import { resolveLaunchAgentPlistPath } from "../daemon/launchd-service-files.js";
import type { SystemdGatewayInstallation } from "../daemon/service-types.js";
import { findSystemdGatewayInstallation } from "../daemon/systemd-scope.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { resolveInstallationTarget } from "./installation-target-context.js";
import type { RespawnSupervisor } from "./supervisor-markers.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import type { ActiveManagedServiceUpdateHandoff } from "./update-managed-service-handoff-types.js";

/** Package ownership permits installation, not control of an operator's system unit. */
export async function admitSystemdUpdate(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  installation?: SystemdGatewayInstallation | null,
): Promise<string | undefined> {
  const installed =
    installation === undefined ? await findSystemdGatewayInstallation(env) : installation;
  if (installed?.kind !== "system") {
    return undefined;
  }
  const unit = installed.system.unitName;
  const restartCommand = `sudo systemctl restart ${quoteCliArg(unit)}`;
  const installRoot = resolveUpdateInstallRoot(root);
  try {
    await fs.access(installRoot, fs.constants.W_OK | fs.constants.X_OK);
  } catch (cause) {
    const { uid } = await fs.stat(installRoot);
    const updateCommand = formatInstallationTargetCommand(
      [process.execPath, path.join(installRoot, "openclaw.mjs"), "update", "--yes", "--no-restart"],
      resolveInstallationTarget(env),
      { env },
    );
    throw new UpdatePreMutationError(
      "managed-service-handoff-failed",
      `System-scope Gateway package update cannot write its install root ${installRoot}. Install as its owning account: sudo -u ${quoteCliArg(`#${uid}`)} -- ${updateCommand}. Then run: ${restartCommand}`,
      { cause },
    );
  }
  return `System-scope Gateway service ${unit} requires an operator restart. Package updates do not stop or restart this service. After the update, run: ${restartCommand}`;
}

/** A detached helper still shares the system unit's cgroup until it settles. */
export function joinSystemServiceUpdateHandoffs(
  owners: ReadonlyMap<string, ActiveManagedServiceUpdateHandoff>,
): Promise<void> | undefined {
  const pending = () =>
    [...owners.values()].filter((owner) => owner.operatorRestartWarning && !owner.settled);
  let updates = pending();
  if (!updates.length) {
    return undefined;
  }
  return (async () => {
    while (updates.length) {
      await Promise.all(
        updates.map(async (owner) => {
          await owner.flight;
          await owner.closed;
          if (!owner.settled) {
            throw new Error("System-service updater settlement could not be confirmed.");
          }
        }),
      );
      updates = pending();
    }
  })();
}

type GatewayServiceRecovery =
  | { kind: "systemd"; unit: string }
  | { kind: "launchd"; uid: number; label: string; plistPath: string }
  | { kind: "schtasks"; taskName: string };

export function resolveGatewayServiceRecovery(
  supervisor: RespawnSupervisor | null | undefined,
  env: NodeJS.ProcessEnv,
): GatewayServiceRecovery | undefined {
  if (supervisor === "systemd") {
    return { kind: "systemd", unit: `${resolveSystemdServiceName(env)}.service` };
  }
  if (supervisor === "launchd") {
    const label = resolveLaunchAgentLabel(env);
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    return { kind: "launchd", uid, label, plistPath: resolveLaunchAgentPlistPath(env) };
  }
  if (supervisor === "schtasks") {
    const taskName =
      env.OPENCLAW_WINDOWS_TASK_NAME?.trim() || resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
    return { kind: "schtasks", taskName };
  }
  return undefined;
}
