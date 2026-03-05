import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import JSON5 from "json5";
import { addConfigAtomicCommands } from "../commands/config-atomic.js";
import {
  getAtomicConfigManager,
  type ConfigValidationResult,
} from "../config/atomic-config.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { CONFIG_PATH } from "../config/paths.js";
import { isBlockedObjectKey } from "../config/prototype-keys.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import {
  createSafeModeConfig,
  createSafeModeSentinel,
  isSafeModeEnabled,
  shouldStartInSafeMode,
} from "../config/safe-mode.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/types.js";
import { danger, info, success, warn } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";

type PathSegment = string;
type ConfigSetParseOpts = {
  strictJson?: boolean;
};
type ConfigIssue = {
  path: string;
  message: string;
};

const OLLAMA_API_KEY_PATH: PathSegment[] = ["models", "providers", "ollama", "apiKey"];
const OLLAMA_PROVIDER_PATH: PathSegment[] = ["models", "providers", "ollama"];
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

function isIndexSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

function parsePath(raw: string): PathSegment[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === "\\") {
      const next = trimmed[i + 1];
      if (next) {
        current += next;
      }
      i += 2;
      continue;
    }
    if (ch === ".") {
      if (current) {
        parts.push(current);
      }
      current = "";
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (current) {
        parts.push(current);
      }
      current = "";
      const close = trimmed.indexOf("]", i);
      if (close === -1) {
        throw new Error(`Invalid path (missing "]"): ${raw}`);
      }
      const inside = trimmed.slice(i + 1, close).trim();
      if (!inside) {
        throw new Error(`Invalid path (empty "[]"): ${raw}`);
      }
      parts.push(inside);
      i = close + 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseValue(raw: string, opts: ConfigSetParseOpts): unknown {
  const trimmed = raw.trim();
  if (opts.strictJson) {
    try {
      return JSON5.parse(trimmed);
    } catch (err) {
      throw new Error(`Failed to parse JSON5 value: ${String(err)}`, { cause: err });
    }
  }

  try {
    return JSON5.parse(trimmed);
  } catch {
    return raw;
  }
}

function hasOwnPathKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeConfigIssues(issues: ReadonlyArray<ConfigIssue>): ConfigIssue[] {
  return issues.map((issue) => ({
    path: issue.path || "<root>",
    message: issue.message,
  }));
}

function formatConfigIssueLines(issues: ReadonlyArray<ConfigIssue>, marker: string): string[] {
  return normalizeConfigIssues(issues).map((issue) => `${marker} ${issue.path}: ${issue.message}`);
}

function formatDoctorHint(message: string): string {
  return `Run \`${formatCliCommand("openclaw doctor")}\` ${message}`;
}

function validatePathSegments(path: PathSegment[]): void {
  for (const segment of path) {
    if (!isIndexSegment(segment) && isBlockedObjectKey(segment)) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }
}

function getAtPath(root: unknown, path: PathSegment[]): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return { found: false };
    }
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return { found: false };
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) {
      return { found: false };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

function setAtPath(root: Record<string, unknown>, path: PathSegment[], value: unknown): void {
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    const next = path[i + 1];
    const nextIsIndex = Boolean(next && isIndexSegment(next));
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        throw new Error(`Expected numeric index for array segment "${segment}"`);
      }
      const index = Number.parseInt(segment, 10);
      const existing = current[index];
      if (!existing || typeof existing !== "object") {
        current[index] = nextIsIndex ? [] : {};
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") {
      throw new Error(`Cannot traverse into "${segment}" (not an object)`);
    }
    const record = current as Record<string, unknown>;
    const existing = record[segment];
    if (!existing || typeof existing !== "object") {
      record[segment] = nextIsIndex ? [] : {};
    }
    current = record[segment];
  }

  const last = path[path.length - 1];
  if (Array.isArray(current)) {
    if (!isIndexSegment(last)) {
      throw new Error(`Expected numeric index for array segment "${last}"`);
    }
    const index = Number.parseInt(last, 10);
    current[index] = value;
    return;
  }
  if (!current || typeof current !== "object") {
    throw new Error(`Cannot set "${last}" (parent is not an object)`);
  }
  (current as Record<string, unknown>)[last] = value;
}

function unsetAtPath(root: Record<string, unknown>, path: PathSegment[]): boolean {
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (!current || typeof current !== "object") {
      return false;
    }
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return false;
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return false;
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) {
      return false;
    }
    current = record[segment];
  }

  const last = path[path.length - 1];
  if (Array.isArray(current)) {
    if (!isIndexSegment(last)) {
      return false;
    }
    const index = Number.parseInt(last, 10);
    if (!Number.isFinite(index) || index < 0 || index >= current.length) {
      return false;
    }
    current.splice(index, 1);
    return true;
  }
  if (!current || typeof current !== "object") {
    return false;
  }
  const record = current as Record<string, unknown>;
  if (!(last in record)) {
    return false;
  }
  delete record[last];
  return true;
}

async function loadValidConfig(runtime: RuntimeEnv = defaultRuntime) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.valid) {
    return snapshot;
  }
  runtime.error(`Config invalid at ${shortenHomePath(snapshot.path)}.`);
  for (const line of formatConfigIssueLines(snapshot.issues, "-")) {
    runtime.error(line);
  }
  runtime.error(formatDoctorHint("to repair, then retry."));
  runtime.exit(1);
  return snapshot;
}

function parseRequiredPath(path: string): PathSegment[] {
  const parsedPath = parsePath(path);
  if (parsedPath.length === 0) {
    throw new Error("Path is empty.");
  }
  validatePathSegments(parsedPath);
  return parsedPath;
}

function pathEquals(path: PathSegment[], expected: PathSegment[]): boolean {
  return (
    path.length === expected.length && path.every((segment, index) => segment === expected[index])
  );
}

function ensureValidOllamaProviderForApiKeySet(
  root: Record<string, unknown>,
  path: PathSegment[],
): void {
  if (!pathEquals(path, OLLAMA_API_KEY_PATH)) {
    return;
  }
  const existing = getAtPath(root, OLLAMA_PROVIDER_PATH);
  if (existing.found) {
    return;
  }
  setAtPath(root, OLLAMA_PROVIDER_PATH, {
    baseUrl: OLLAMA_DEFAULT_BASE_URL,
    api: "ollama",
    models: [],
  });
}

export async function runConfigGet(opts: { path: string; json?: boolean; runtime?: RuntimeEnv }) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const parsedPath = parseRequiredPath(opts.path);
    const snapshot = await loadValidConfig(runtime);
    const redacted = redactConfigObject(snapshot.config);
    const res = getAtPath(redacted, parsedPath);
    if (!res.found) {
      runtime.error(danger(`Config path not found: ${opts.path}`));
      runtime.exit(1);
      return;
    }
    if (opts.json) {
      runtime.log(JSON.stringify(res.value ?? null, null, 2));
      return;
    }
    if (
      typeof res.value === "string" ||
      typeof res.value === "number" ||
      typeof res.value === "boolean"
    ) {
      runtime.log(String(res.value));
      return;
    }
    runtime.log(JSON.stringify(res.value ?? null, null, 2));
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}

export async function runConfigUnset(opts: { path: string; runtime?: RuntimeEnv }) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const parsedPath = parseRequiredPath(opts.path);
    const snapshot = await loadValidConfig(runtime);
    // Use snapshot.resolved (config after $include and ${ENV} resolution, but BEFORE runtime defaults)
    // instead of snapshot.config (runtime-merged with defaults).
    // This prevents runtime defaults from leaking into the written config file (issue #6070)
    const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
    const removed = unsetAtPath(next, parsedPath);
    if (!removed) {
      runtime.error(danger(`Config path not found: ${opts.path}`));
      runtime.exit(1);
      return;
    }
    await writeConfigFile(next, { unsetPaths: [parsedPath] });
    runtime.log(info(`Removed ${opts.path}. Restart the gateway to apply.`));
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}

export async function runConfigFile(opts: { runtime?: RuntimeEnv }) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const snapshot = await readConfigFileSnapshot();
    runtime.log(shortenHomePath(snapshot.path));
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}

/**
 * Shared validation logic used by both `config validate` CLI and `applyConfigAtomic()`.
 * Returns schema issues from the snapshot plus optional 12-factor checks.
 */
export async function validateConfigForApply(
  snapshot: ConfigFileSnapshot,
  opts: { twelveFactorCheck?: boolean } = {},
): Promise<{
  schemaValid: boolean;
  issues: ReadonlyArray<ConfigIssue>;
  atomicValidation?: ConfigValidationResult;
}> {
  const issues = snapshot.valid ? [] : normalizeConfigIssues(snapshot.issues);
  let atomicValidation: ConfigValidationResult | undefined;

  if (snapshot.exists && snapshot.valid && opts.twelveFactorCheck) {
    try {
      const manager = getAtomicConfigManager();
      atomicValidation = await manager.validateConfig(snapshot.config);
    } catch {
      // Atomic validation is best-effort
    }
  }

  return {
    schemaValid: snapshot.valid,
    issues,
    atomicValidation,
  };
}

function detectStaleTempFiles(configPath: string): string[] {
  const stateDir = path.dirname(configPath);
  const tempDir = path.join(stateDir, "config-temp");
  try {
    if (!fs.existsSync(tempDir)) return [];
    return fs.readdirSync(tempDir).filter((f) => f.endsWith(".tmp"));
  } catch {
    return [];
  }
}

function getBackupSummary(): { count: number; lastHealthy?: string } | null {
  try {
    const manager = getAtomicConfigManager();
    // listBackups is async but we use a sync summary check
    return null;
  } catch {
    return null;
  }
}

export async function runConfigValidate(
  opts: {
    json?: boolean;
    checkBackups?: boolean;
    twelveFactorCheck?: boolean;
    fix?: boolean;
    runtime?: RuntimeEnv;
  } = {},
) {
  const runtime = opts.runtime ?? defaultRuntime;
  let outputPath = CONFIG_PATH ?? "openclaw.json";

  try {
    const snapshot = await readConfigFileSnapshot();
    outputPath = snapshot.path;
    const shortPath = shortenHomePath(outputPath);

    // Safe-mode banner
    if (!opts.json) {
      if (isSafeModeEnabled() || shouldStartInSafeMode()) {
        runtime.log(warn("Safe mode is active. Config changes are restricted."));
        runtime.log("");
      }
    }

    if (!snapshot.exists) {
      if (opts.json) {
        runtime.log(JSON.stringify({ valid: false, path: outputPath, error: "file not found" }));
      } else {
        runtime.error(danger(`Config file not found: ${shortPath}`));
      }
      runtime.exit(1);
      return;
    }

    // Stale .tmp file check
    const staleTmps = detectStaleTempFiles(outputPath);
    if (staleTmps.length > 0 && !opts.json) {
      runtime.log(
        warn(
          `Found ${staleTmps.length} stale .tmp file(s) in config-temp/. A previous atomic apply may have been interrupted.`,
        ),
      );
      runtime.log(
        theme.muted(
          `  Clean up with: rm ${path.join(path.dirname(outputPath), "config-temp", "*.tmp")}`,
        ),
      );
      runtime.log("");
    }

    // Schema validation
    const { schemaValid, issues, atomicValidation } = await validateConfigForApply(snapshot, {
      twelveFactorCheck: opts.twelveFactorCheck,
    });

    if (!schemaValid) {
      if (opts.json) {
        runtime.log(
          JSON.stringify({ valid: false, path: outputPath, issues, staleTmps: staleTmps.length }, null, 2),
        );
      } else {
        runtime.error(danger(`Config invalid at ${shortPath}:`));
        for (const line of formatConfigIssueLines(issues, danger("×"))) {
          runtime.error(`  ${line}`);
        }
        runtime.error("");
        runtime.error(formatDoctorHint("to repair, or fix the keys above manually."));

        if (opts.fix) {
          runtime.log("");
          runtime.log(warn("--fix: entering safe mode to allow recovery..."));
          const safeConfig = createSafeModeConfig();
          await createSafeModeSentinel("config validate --fix: critical schema errors");
          runtime.log(success("Safe mode sentinel created. Restart the gateway to enter safe mode."));
          runtime.log(
            theme.muted(
              `  To disable later: ${formatCliCommand("openclaw config safe-mode disable")}`,
            ),
          );
        }
      }
      runtime.exit(1);
      return;
    }

    // Backup status (when --check-backups)
    let backupInfo: { count: number; lastHealthy?: string } | undefined;
    if (opts.checkBackups) {
      try {
        const manager = getAtomicConfigManager();
        const backups = await manager.listBackups();
        const lastHealthy = backups.find((b) => b.healthy);
        backupInfo = {
          count: backups.length,
          lastHealthy: lastHealthy?.id,
        };
        if (!opts.json) {
          if (backups.length === 0) {
            runtime.log(warn("No config backups found. Run `openclaw config backup` to create one."));
          } else {
            runtime.log(
              info(
                `${backups.length} backup(s) available${lastHealthy ? `, last healthy: ${lastHealthy.id}` : ""}`,
              ),
            );
          }
        }
      } catch {
        if (!opts.json) {
          runtime.log(theme.muted("Could not read backup status."));
        }
      }
    }

    // 12-factor results
    if (atomicValidation && !opts.json) {
      if (!atomicValidation.valid) {
        runtime.log("");
        runtime.log(danger("Atomic validation errors:"));
        for (const err of atomicValidation.errors) {
          runtime.log(danger(`  - ${err}`));
        }
      }
      if (atomicValidation.warnings.length > 0) {
        runtime.log("");
        runtime.log(warn("Warnings:"));
        for (const w of atomicValidation.warnings) {
          runtime.log(warn(`  - ${w}`));
        }
      }
      if (atomicValidation.twelveFactorIssues.length > 0) {
        runtime.log("");
        runtime.log(theme.muted("12-Factor App Issues:"));
        for (const issue of atomicValidation.twelveFactorIssues) {
          runtime.log(theme.muted(`  - ${issue}`));
        }
      }
    }

    // JSON output
    if (opts.json) {
      const result: Record<string, unknown> = { valid: true, path: outputPath };
      if (staleTmps.length > 0) result.staleTmps = staleTmps.length;
      if (backupInfo) result.backups = backupInfo;
      if (atomicValidation) {
        result.atomicValidation = {
          valid: atomicValidation.valid,
          warnings: atomicValidation.warnings,
          twelveFactorIssues: atomicValidation.twelveFactorIssues,
        };
      }
      runtime.log(JSON.stringify(result, null, 2));
    } else {
      runtime.log(success(`Config valid: ${shortPath}`));
    }

    if (atomicValidation && !atomicValidation.valid) {
      runtime.exit(1);
    }
  } catch (err) {
    if (opts.json) {
      runtime.log(JSON.stringify({ valid: false, path: outputPath, error: String(err) }));
    } else {
      runtime.error(danger(`Config validation error: ${String(err)}`));
    }
    runtime.exit(1);
  }
}

export function registerConfigCli(program: Command) {
  const cmd = program
    .command("config")
    .description(
      "Non-interactive config helpers (get/set/unset/file/validate). Run without subcommand for the setup wizard.",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/config", "docs.openclaw.ai/cli/config")}\n`,
    )
    .option(
      "--section <section>",
      "Configure wizard sections (repeatable). Use with no subcommand.",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts) => {
      const { CONFIGURE_WIZARD_SECTIONS, configureCommand, configureCommandWithSections } =
        await import("../commands/configure.js");
      const sections: string[] = Array.isArray(opts.section)
        ? opts.section
            .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
            .filter(Boolean)
        : [];
      if (sections.length === 0) {
        await configureCommand(defaultRuntime);
        return;
      }

      const invalid = sections.filter((s) => !CONFIGURE_WIZARD_SECTIONS.includes(s as never));
      if (invalid.length > 0) {
        defaultRuntime.error(
          `Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}.`,
        );
        defaultRuntime.exit(1);
        return;
      }

      await configureCommandWithSections(sections as never, defaultRuntime);
    });

  cmd
    .command("get")
    .description("Get a config value by dot path")
    .argument("<path>", "Config path (dot or bracket notation)")
    .option("--json", "Output JSON", false)
    .action(async (path: string, opts) => {
      await runConfigGet({ path, json: Boolean(opts.json) });
    });

  cmd
    .command("set")
    .description("Set a config value by dot path")
    .argument("<path>", "Config path (dot or bracket notation)")
    .argument("<value>", "Value (JSON5 or raw string)")
    .option("--strict-json", "Strict JSON5 parsing (error instead of raw string fallback)", false)
    .option("--json", "Legacy alias for --strict-json", false)
    .action(async (path: string, value: string, opts) => {
      try {
        const parsedPath = parseRequiredPath(path);
        const parsedValue = parseValue(value, {
          strictJson: Boolean(opts.strictJson || opts.json),
        });
        const snapshot = await loadValidConfig();
        // Use snapshot.resolved (config after $include and ${ENV} resolution, but BEFORE runtime defaults)
        // instead of snapshot.config (runtime-merged with defaults).
        // This prevents runtime defaults from leaking into the written config file (issue #6070)
        const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
        ensureValidOllamaProviderForApiKeySet(next, parsedPath);
        setAtPath(next, parsedPath, parsedValue);
        await writeConfigFile(next);
        defaultRuntime.log(info(`Updated ${path}. Restart the gateway to apply.`));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  cmd
    .command("unset")
    .description("Remove a config value by dot path")
    .argument("<path>", "Config path (dot or bracket notation)")
    .action(async (path: string) => {
      await runConfigUnset({ path });
    });

  cmd
    .command("file")
    .description("Print the active config file path")
    .action(async () => {
      await runConfigFile({});
    });

  cmd
    .command("validate")
    .description("Validate the current config against the schema without starting the gateway")
    .option("--json", "Output validation result as JSON", false)
    .option("--check-backups", "Show backup status", false)
    .option("--12-factor", "Include 12-factor app validation", false)
    .option("--fix", "Enter safe mode on critical errors", false)
    .action(async (opts) => {
      await runConfigValidate({
        json: Boolean(opts.json),
        checkBackups: Boolean(opts.checkBackups),
        twelveFactorCheck: Boolean(opts["12Factor"]),
        fix: Boolean(opts.fix),
      });
    });

  // Add atomic configuration management commands
  addConfigAtomicCommands(cmd);
}
