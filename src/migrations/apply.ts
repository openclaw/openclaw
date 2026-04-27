import fs from "node:fs/promises";
import path from "node:path";
import { writeConfigFile } from "../config/config.js";
import { resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { mergeConfigPathCreate, setConfigPathCreate } from "./config-merge.js";
import { inspectExistingOpenClawState } from "./freshness.js";
import { timestampForPath } from "./path-utils.js";
import { redactMigrationPlan, writeMigrationReport } from "./report.js";
import type {
  MigrationAction,
  MigrationApplyOptions,
  MigrationApplyResult,
  MigrationItemResult,
} from "./types.js";

async function exists(candidate: string): Promise<boolean> {
  return fs
    .access(candidate)
    .then(() => true)
    .catch(() => false);
}

async function ensureNoConflict(target: string, mode: "fail" | "skip" | "rename" | "overwrite") {
  if (!(await exists(target)) || mode === "overwrite") {
    return target;
  }
  if (mode === "skip") {
    return null;
  }
  if (mode === "rename") {
    const parsed = path.parse(target);
    for (let index = 1; index < 1000; index += 1) {
      const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
      if (!(await exists(candidate))) {
        return candidate;
      }
    }
  }
  throw new Error(`Target already exists: ${target}`);
}

async function copyFileAction(action: Extract<MigrationAction, { kind: "copyFile" }>) {
  const target = await ensureNoConflict(action.target, action.conflict);
  if (!target) {
    return { status: "skipped" as const, target: action.target, details: "target exists" };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(action.source, target);
  return { status: "migrated" as const, target };
}

async function copyTreeAction(action: Extract<MigrationAction, { kind: "copyTree" }>) {
  const target = await ensureNoConflict(action.target, action.conflict);
  if (!target) {
    return { status: "skipped" as const, target: action.target, details: "target exists" };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(action.source, target, { recursive: true, force: action.conflict === "overwrite" });
  return { status: "migrated" as const, target };
}

async function writeEnvValue(envPath: string, key: string, value: string | undefined) {
  if (value === undefined) {
    return;
  }
  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf-8");
  } catch {
    // New .env.
  }
  const lines = existing ? existing.split(/\r?\n/u).filter((line) => line.length > 0) : [];
  const escaped = JSON.stringify(value);
  const nextLine = `${key}=${escaped}`;
  const keyPrefix = `${key}=`;
  const index = lines.findIndex((line) => line.startsWith(keyPrefix));
  if (index >= 0) {
    lines[index] = nextLine;
  } else {
    lines.push(nextLine);
  }
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(envPath, 0o600).catch(() => undefined);
}

function enablePlugin(
  config: OpenClawConfig,
  action: Extract<MigrationAction, { kind: "enablePlugin" }>,
) {
  const record = config as Record<string, unknown>;
  const plugins = isRecord(record.plugins) ? record.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const previous = isRecord(entries[action.pluginId])
    ? (entries[action.pluginId] as Record<string, unknown>)
    : {};
  entries[action.pluginId] = {
    ...previous,
    enabled: true,
    ...(action.config && Object.keys(action.config).length > 0 ? { config: action.config } : {}),
  };
  plugins.entries = entries;
  if (
    Array.isArray(plugins.allow) &&
    plugins.allow.length > 0 &&
    !plugins.allow.includes(action.pluginId)
  ) {
    plugins.allow = [...plugins.allow, action.pluginId];
  }
  record.plugins = plugins;
}

function applyConfigAction(config: OpenClawConfig, action: MigrationAction): boolean {
  if (action.kind === "mergeConfig") {
    mergeConfigPathCreate(config as Record<string, unknown>, action.path, action.value);
    return true;
  }
  if (action.kind === "writeSecretRef") {
    setConfigPathCreate(config as Record<string, unknown>, action.targetPath, {
      source: "env",
      provider: "default",
      id: action.envKey,
    });
    return true;
  }
  if (action.kind === "enablePlugin") {
    enablePlugin(config, action);
    return true;
  }
  return false;
}

function resultFor(
  action: MigrationAction,
  params: Partial<MigrationItemResult>,
): MigrationItemResult {
  return {
    actionId: action.id,
    kind: action.kind,
    category: action.category,
    status: params.status ?? "planned",
    reason: action.reason,
    source: "source" in action ? action.source : undefined,
    target:
      params.target ??
      ("target" in action
        ? action.target
        : action.kind === "writeSecretRef"
          ? action.targetPath.join(".")
          : undefined),
    details: params.details,
  };
}

export async function applyMigrationPlan(
  options: MigrationApplyOptions,
): Promise<MigrationApplyResult> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const plan = options.plan;
  const reportDir = path.join(
    plan.targetStateDir,
    "migrations",
    plan.providerId,
    plan.id || timestampForPath(),
  );

  if (!dryRun && options.allowExisting !== true) {
    const existing = await inspectExistingOpenClawState({
      targetStateDir: plan.targetStateDir,
      targetWorkspaceDir: plan.targetWorkspaceDir,
      env,
    });
    if (existing.meaningful) {
      throw new Error(
        [
          "This OpenClaw setup already has state. Import into existing setups is disabled.",
          "Create a fresh setup and import there.",
          "Existing state:",
          ...existing.reasons.map((reason) => `- ${reason}`),
        ].join("\n"),
      );
    }
  }

  const nextConfig: OpenClawConfig = structuredClone(options.baseConfig ?? {});
  const results: MigrationItemResult[] = [];
  let configChanged = false;
  const envPath = path.join(plan.targetStateDir, ".env");

  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, "plan.json"),
    `${JSON.stringify(redactMigrationPlan(plan), null, 2)}\n`,
    "utf-8",
  );

  for (const action of plan.actions) {
    if (dryRun) {
      results.push(resultFor(action, { status: "planned" }));
      continue;
    }
    try {
      if (action.kind === "copyFile") {
        const copied = await copyFileAction(action);
        results.push(resultFor(action, copied));
        continue;
      }
      if (action.kind === "copyTree") {
        const copied = await copyTreeAction(action);
        results.push(resultFor(action, copied));
        continue;
      }
      if (action.kind === "writeEnv") {
        await writeEnvValue(envPath, action.key, action.value);
        results.push(resultFor(action, { status: "migrated", target: envPath }));
        continue;
      }
      if (action.kind === "archiveOnly") {
        const target = path.join(reportDir, action.archivePath);
        const stat = await fs.stat(action.source);
        if (stat.isDirectory()) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.cp(action.source, target, { recursive: true });
        } else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(action.source, target);
        }
        results.push(resultFor(action, { status: "archived", target }));
        continue;
      }
      if (action.kind === "manual") {
        results.push(resultFor(action, { status: "manual", details: action.recommendation }));
        continue;
      }
      if (applyConfigAction(nextConfig, action)) {
        configChanged = true;
        results.push(resultFor(action, { status: "migrated" }));
        continue;
      }
      results.push(resultFor(action, { status: "skipped", details: "unsupported action" }));
    } catch (error) {
      results.push(
        resultFor(action, {
          status: "error",
          details: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  if (!dryRun && configChanged) {
    await fs.mkdir(plan.targetStateDir, { recursive: true });
    const configPath = resolveConfigPath(env, plan.targetStateDir);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_STATE_DIR = previousStateDir ?? plan.targetStateDir;
    process.env.OPENCLAW_CONFIG_PATH = previousConfigPath ?? configPath;
    try {
      await writeConfigFile(nextConfig, { skipRuntimeSnapshotRefresh: true });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
    }
  }

  const result: MigrationApplyResult = {
    planId: plan.id,
    dryRun,
    reportDir,
    results,
    nextConfig,
  };
  await writeMigrationReport(result);
  return result;
}
