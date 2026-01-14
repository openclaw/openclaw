import { findLegacyLaunchAgents, uninstallLegacyLaunchAgents } from "./launchd.js";
import { findLegacyScheduledTasks, uninstallLegacyScheduledTasks } from "./schtasks.js";
import { findLegacySystemdUnits, uninstallLegacySystemdUnits } from "./systemd.js";

export type LegacyGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
};

function formatLegacyLaunchAgents(
  agents: Awaited<ReturnType<typeof findLegacyLaunchAgents>>,
): LegacyGatewayService[] {
  return agents.map((agent) => ({
    platform: "darwin",
    label: agent.label,
    detail: [
      agent.loaded ? "loaded" : "not loaded",
      agent.exists ? `plist: ${agent.plistPath}` : "plist missing",
    ].join(", "),
  }));
}

function formatLegacySystemdUnits(
  units: Awaited<ReturnType<typeof findLegacySystemdUnits>>,
): LegacyGatewayService[] {
  return units.map((unit) => ({
    platform: "linux",
    label: `${unit.name}.service`,
    detail: [
      unit.enabled ? "enabled" : "disabled",
      unit.exists ? `unit: ${unit.unitPath}` : "unit missing",
    ].join(", "),
  }));
}

function formatLegacyScheduledTasks(
  tasks: Awaited<ReturnType<typeof findLegacyScheduledTasks>>,
): LegacyGatewayService[] {
  return tasks.map((task) => ({
    platform: "win32",
    label: task.name,
    detail: [
      task.installed ? "installed" : "not installed",
      task.scriptExists ? `script: ${task.scriptPath}` : "script missing",
    ].join(", "),
  }));
}

export async function findLegacyGatewayServices(
  env: Record<string, string | undefined>,
): Promise<LegacyGatewayService[]> {
  if (process.platform === "darwin") {
    const agents = await findLegacyLaunchAgents(env);
    return formatLegacyLaunchAgents(agents);
  }

  if (process.platform === "linux") {
    const units = await findLegacySystemdUnits(env);
    return formatLegacySystemdUnits(units);
  }

  if (process.platform === "win32") {
    const tasks = await findLegacyScheduledTasks(env);
    return formatLegacyScheduledTasks(tasks);
  }

  return [];
}

export async function uninstallLegacyGatewayServices({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<LegacyGatewayService[]> {
  if (process.platform === "darwin") {
    const agents = await uninstallLegacyLaunchAgents({ env, stdout });
    return formatLegacyLaunchAgents(agents);
  }

  if (process.platform === "linux") {
    const units = await uninstallLegacySystemdUnits({ env, stdout });
    return formatLegacySystemdUnits(units);
  }

  if (process.platform === "win32") {
    const tasks = await uninstallLegacyScheduledTasks({ env, stdout });
    return formatLegacyScheduledTasks(tasks);
  }

  return [];
}
