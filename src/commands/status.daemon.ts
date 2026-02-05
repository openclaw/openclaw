import { readdir } from "node:fs/promises";
import type { GatewayService } from "../daemon/service.js";
import { resolveStateDir } from "../config/config.js";
import { resolveNodeService } from "../daemon/node-service.js";
import { resolveGatewayService } from "../daemon/service.js";
import { formatDaemonRuntimeShort } from "./status.format.js";

type DaemonStatusSummary = {
  label: string;
  installed: boolean | null;
  loadedText: string;
  runtimeShort: string | null;
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
  service: GatewayService,
  fallbackLabel: string,
): Promise<DaemonStatusSummary> {
  try {
    const [loaded, runtime, command] = await Promise.all([
      service.isLoaded({ env: process.env }).catch(() => false),
      service.readRuntime(process.env).catch(() => undefined),
      service.readCommand(process.env).catch(() => null),
    ]);
    const installed = command != null;
    const loadedText = loaded ? service.loadedText : service.notLoadedText;
    const runtimeShort = formatDaemonRuntimeShort(runtime);

    const mergedEnv = { ...process.env, ...(command?.environment ?? {}) };
    const stateDir = resolveStateDir(mergedEnv as NodeJS.ProcessEnv);
    // console.error("DEBUG: stateDir", stateDir);

    const extraResources = {
      agents: await countDirItems(`${stateDir}/agents`),
      skills: await countDirItems(`${stateDir}/skills`),
      rules: await countDirItems(`${stateDir}/rules`),
      commands: await countDirItems(`${stateDir}/commands`),
    };
    // console.error("DEBUG: resources", JSON.stringify(extraResources));

    return { label: service.label, installed, loadedText, runtimeShort, extraResources };
  } catch (e: any) {
    // console.error("DEBUG: error in buildDaemonStatusSummary", e);
    return {
      label: fallbackLabel,
      installed: null,
      loadedText: "unknown",
      runtimeShort: null,
    };
  }
}

export async function getDaemonStatusSummary(): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary(resolveGatewayService(), "Daemon");
}

export async function getNodeDaemonStatusSummary(): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary(resolveNodeService(), "Node");
}
