import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAWORKS_GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_LAUNCH_AGENT_LABEL,
} from "../daemon/constants.js";
import { OPENCLAW_RESERVED_GATEWAY_PORT } from "./claworks-gateway.js";
import { isClaworksProduct } from "./paths.js";

const CLAWORKS_GATEWAY_LIFECYCLE_COMMANDS = new Set([
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
  "run",
]);

function readLaunchAgentPlist(label: string): string | null {
  const plistPath = path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
  try {
    return fs.readFileSync(plistPath, "utf8");
  } catch {
    return null;
  }
}

/** OpenClaw LaunchAgent mistakenly installed for ClaWorks state/paths. */
export function detectMisplacedOpenClawLaunchAgent(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (process.platform !== "darwin" || !isClaworksProduct(env)) {
    return null;
  }
  const content = readLaunchAgentPlist(GATEWAY_LAUNCH_AGENT_LABEL);
  if (!content) {
    return null;
  }
  if (content.includes(".claworks") || content.includes("claworks.json")) {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return null;
}

/** ClaWorks LaunchAgent still bound to OpenClaw's reserved port. */
export function detectClaworksLaunchAgentPortConflict(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (process.platform !== "darwin" || !isClaworksProduct(env)) {
    return false;
  }
  const content = readLaunchAgentPlist(CLAWORKS_GATEWAY_LAUNCH_AGENT_LABEL);
  if (!content) {
    return false;
  }
  return content.includes(`<string>${OPENCLAW_RESERVED_GATEWAY_PORT}</string>`);
}

export function isClaworksRepoCheckout(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, "claworks.mjs"));
}

/** Block openclaw entry for gateway lifecycle in the ClaWorks repo checkout. */
export function shouldBlockOpenClawGatewayLifecycleArgv(
  argv: string[],
  params?: { claworksProduct?: boolean; isClaworksRepo?: boolean },
): boolean {
  if (params?.claworksProduct ?? process.env.CLAWORKS_PRODUCT === "1") {
    return false;
  }
  if (!(params?.isClaworksRepo ?? false)) {
    return false;
  }
  const tokens = argv.filter((token) => token.length > 0 && !token.startsWith("-"));
  const command = tokens[0];
  const subcommand = tokens[1];
  if (command !== "gateway" || !subcommand) {
    return false;
  }
  return CLAWORKS_GATEWAY_LIFECYCLE_COMMANDS.has(subcommand);
}
