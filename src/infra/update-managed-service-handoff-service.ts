import fs from "node:fs/promises";
import path from "node:path";
import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { UpdatePreMutationError } from "../cli/update-cli/shared.js";
import { resolveUpdatedInstallCommandEnv } from "../cli/update-cli/update-command-service-env.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../daemon/launchd-label.js";
import { resolveLaunchAgentPlistPath } from "../daemon/launchd-service-files.js";
import type { SystemdGatewayInstallation } from "../daemon/service-types.js";
import { findSystemdGatewayInstallation } from "../daemon/systemd-scope.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { installationTargetEnv, resolveInstallationTarget } from "./installation-target-context.js";
import { SUPERVISOR_HINT_ENV_VARS, type RespawnSupervisor } from "./supervisor-markers.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  UPDATE_RUN_ID_ENV,
} from "./update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import {
  createHandoffLineReader,
  type HandoffChild,
} from "./update-managed-service-handoff-control.js";
import type { ActiveManagedServiceUpdateHandoff } from "./update-managed-service-handoff-types.js";

const SERVICE_IDENTITY_ENV_VARS = new Set<string>([
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const);

export function resolveManagedHandoffCommandEnv(
  serviceEnv: NodeJS.ProcessEnv,
  metaPath: string,
  runId?: string,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...serviceEnv,
    // Resolve relative/default target selectors before entering the helper scratch directory.
    ...installationTargetEnv(resolveInstallationTarget(serviceEnv)),
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    ...(runId ? { [UPDATE_RUN_ID_ENV]: runId } : {}),
  };
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    if (!SERVICE_IDENTITY_ENV_VARS.has(key)) {
      delete childEnv[key];
    }
  }
  return resolveUpdatedInstallCommandEnv({
    processEnv: childEnv,
    invocationCwd: process.cwd(),
  });
}

/** Package ownership permits installation, not control of an operator's system unit. */
export async function admitSystemdUpdate(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  installation?: SystemdGatewayInstallation | null,
): Promise<string | undefined> {
  const installed =
    installation === undefined ? await findSystemdGatewayInstallation(env) : installation;
  // The same unit in both scopes still has a system owner; lifecycle discovery
  // remains user-first, but update admission must not discard that restriction.
  if (installed?.kind !== "system" && installed?.kind !== "dueling") {
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

export const SYSTEM_SERVICE_UPDATE_SETTLED_MARKER = "system-update-settled\n";

/** Helper exit alone cannot prove that its detached updater has stopped. */
export function observeManagedServiceUpdateHandoffClose(
  owner: ActiveManagedServiceUpdateHandoff,
  child: HandoffChild,
): Promise<void> {
  let cleanupSettled = false;
  const onData = createHandoffLineReader((line) => {
    if (line === SYSTEM_SERVICE_UPDATE_SETTLED_MARKER) {
      cleanupSettled = true;
    }
  });
  child.stdout.on("data", onData);
  return new Promise((resolve) => {
    child.once("close", () => {
      child.stdout.off("data", onData);
      owner.settled = cleanupSettled && child.exitCode !== null && child.signalCode === null;
      resolve();
    });
  });
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
