import { readdir } from "node:fs/promises";
import { resolveStateDir } from "../config/config.js";
import { resolveNodeService } from "../daemon/node-service.js";
import { resolveGatewayService } from "../daemon/service.js";
import { formatDaemonRuntimeShort } from "./status.format.js";
import { readServiceStatusSummary } from "./status.service-summary.js";

type DaemonStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: Awaited<ReturnType<typeof readServiceStatusSummary>>["runtime"];
  runtimeShort: string | null;
  layout: Awaited<ReturnType<typeof readServiceStatusSummary>>["layout"];
  extraResources?: {
    agents: number;
    skills: number;
    rules: number;
    commands: number;
  };
};

async function countDirItems(dir: string): Promise<number> {
  try {
    // console.error("DEBUG: reading", dir);
    const items = await readdir(dir);
    return items.filter((i) => !i.startsWith(".")).length;
  } catch (e) {
    // console.error("DEBUG: failed reading", dir, e);
    return 0;
  }
}

async function buildDaemonStatusSummary(
  serviceLabel: "gateway" | "node",
): Promise<DaemonStatusSummary> {
  const service = serviceLabel === "gateway" ? resolveGatewayService() : resolveNodeService();
  const fallbackLabel = serviceLabel === "gateway" ? "Daemon" : "Node";
  const summary = await readServiceStatusSummary(service, fallbackLabel);
  const command = await service.readCommand(process.env).catch(() => null);
  const mergedEnv = { ...process.env, ...(command?.environment ?? {}) };
  const stateDir = resolveStateDir(mergedEnv as NodeJS.ProcessEnv);
  const extraResources = {
    agents: await countDirItems(`${stateDir}/agents`),
    skills: await countDirItems(`${stateDir}/skills`),
    rules: await countDirItems(`${stateDir}/rules`),
    commands: await countDirItems(`${stateDir}/commands`),
  };
  return {
    label: summary.label,
    installed: summary.installed,
    loaded: summary.loaded,
    managedByOpenClaw: summary.managedByOpenClaw,
    externallyManaged: summary.externallyManaged,
    loadedText: summary.loadedText,
    runtime: summary.runtime,
    runtimeShort: formatDaemonRuntimeShort(summary.runtime),
    layout: summary.layout,
    extraResources,
  };
}

export async function getDaemonStatusSummary(): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary("gateway");
}

export async function getNodeDaemonStatusSummary(): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary("node");
}
