import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverPackSourceDir,
  hasPackSourcesAvailable,
  isClaworksRobotConfigPresent,
  repairClaworksJsonConfig,
  type ProductConfigRepairResult,
} from "@claworks/runtime";
import { CLAWORKS_STANDARD_GATEWAY_PORT } from "../../config/claworks-gateway.js";
import { isClaworksProduct, resolveConfigPath, resolveStateDir } from "../../config/paths.js";

export type ClaworksBootstrapResult = {
  configPath: string;
  stateDir: string;
  created: boolean;
  repair: ProductConfigRepairResult | null;
  robotPluginReady: boolean;
  packSource: string | null;
  port: number;
};

export type ClaworksBootstrapOptions = {
  /** Write init skeleton when config is missing (default true). */
  initIfMissing?: boolean;
  /** Apply repairClaworksJsonConfig when config exists (default true). */
  repair?: boolean;
  /** Log lines (stdout). */
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
};

function repoRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function runInitScript(env: NodeJS.ProcessEnv, log?: (line: string) => void): boolean {
  const root = repoRootFromModule();
  const initScript = path.join(root, "scripts/claworks-init.mjs");
  if (!fs.existsSync(initScript)) {
    log?.(`[claworks] init script missing: ${initScript}`);
    return false;
  }
  log?.("[claworks] Creating ~/.claworks/claworks.json …");
  const result = spawnSync(process.execPath, [initScript], {
    cwd: root,
    env: { ...env, CLAWORKS_PRODUCT: "1" },
    stdio: "inherit",
  });
  return result.status === 0;
}

function readConfigObject(configPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function robotPluginReady(config: Record<string, unknown> | null): boolean {
  if (!config) {
    return false;
  }
  return isClaworksRobotConfigPresent(config);
}

/**
 * OpenClaw-style first-run bootstrap for ClaWorks product mode:
 * init skeleton → repair robot/packs/port → verify pack source.
 */
export function ensureClaworksProductReady(
  opts: ClaworksBootstrapOptions = {},
): ClaworksBootstrapResult {
  const env = opts.env ?? process.env;
  if (!isClaworksProduct(env)) {
    throw new Error("ensureClaworksProductReady requires CLAWORKS_PRODUCT=1");
  }
  const log = opts.log;
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const port = Number(env.CLAWORKS_GATEWAY_PORT ?? CLAWORKS_STANDARD_GATEWAY_PORT);
  let created = false;
  let repair: ProductConfigRepairResult | null = null;

  if (!fs.existsSync(configPath)) {
    if (opts.initIfMissing === false) {
      return {
        configPath,
        stateDir,
        created: false,
        repair: null,
        robotPluginReady: false,
        packSource: discoverPackSourceDir(),
        port,
      };
    }
    if (!runInitScript(env, log)) {
      throw new Error(`Failed to initialize ClaWorks config at ${configPath}`);
    }
    created = true;
  }

  if (opts.repair !== false && fs.existsSync(configPath)) {
    const config = readConfigObject(configPath);
    if (config) {
      const packSource = discoverPackSourceDir();
      repair = repairClaworksJsonConfig(config, {
        packSourceDir: packSource,
        stateDir,
        seedRobotMd: true,
      });
      if (repair.changed) {
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        for (const action of repair.actions) {
          log?.(`[claworks] repair: ${action}`);
        }
      }
      for (const warn of repair.warnings) {
        log?.(`[claworks] warn: ${warn}`);
      }
    }
  }

  const finalConfig = readConfigObject(configPath);
  if (!hasPackSourcesAvailable({ stateDir })) {
    log?.("[claworks] warn: no pack sources — clone ../claworks-packs or set CLAWORKS_PACKS_DIR");
  }
  const packSource = discoverPackSourceDir();

  return {
    configPath,
    stateDir,
    created,
    repair,
    robotPluginReady: robotPluginReady(finalConfig),
    packSource,
    port,
  };
}

export function printClaworksStartupBanner(
  result: ClaworksBootstrapResult,
  log: (line: string) => void,
): void {
  const base = `http://127.0.0.1:${result.port}`;
  log("");
  log("ClaWorks ready to start Gateway");
  log(`  Config:  ${result.configPath}`);
  log(`  State:   ${result.stateDir}`);
  log(`  Health:  ${base}/v1/health`);
  log(`  MCP:     ${base}/mcp`);
  log(`  Studio:  ${base}/studio`);
  if (result.packSource) {
    log(`  Packs:   ${result.packSource}`);
  }
  if (!result.robotPluginReady) {
    log("  ⚠ claworks-robot not enabled — run: claworks doctor --fix");
  }
  log("");
}
