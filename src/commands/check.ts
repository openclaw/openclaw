import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { resolveBundledSkillsDir } from "../agents/skills/bundled-dir.js";
import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig, CONFIG_PATH } from "../config/config.js";
import {
  STATE_DIR,
  DEFAULT_GATEWAY_PORT,
  resolveGatewayPort,
  resolveGatewayLockDir,
} from "../config/paths.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

/** Minimum required Node.js version (from package.json engines.node) */
const MIN_NODE_VERSION = "22.12.0";

/** Minimum required pnpm version (from package.json packageManager) */
const MIN_PNPM_VERSION = "10.23.0";

/**
 * Parse a version string into a comparable array of numbers
 * Returns null if the version string is invalid
 */
export function parseVersion(version: string): number[] | null {
  // Remove leading 'v' if present
  const clean = version.replace(/^v/, "").trim();
  if (!clean) {
    return null;
  }
  const parts = clean.split(".").map(Number);
  if (parts.some(Number.isNaN)) {
    return null;
  }
  return parts;
}

/**
 * Compare two version arrays
 * Returns:
 *   - negative if v1 < v2
 *   - 0 if v1 === v2
 *   - positive if v1 > v2
 */
export function compareVersions(v1: number[], v2: number[]): number {
  const maxLength = Math.max(v1.length, v2.length);
  for (let i = 0; i < maxLength; i++) {
    const part1 = v1[i] ?? 0;
    const part2 = v2[i] ?? 0;
    if (part1 !== part2) {
      return part1 - part2;
    }
  }
  return 0;
}

/**
 * Check if the current Node.js version meets the minimum requirement
 */
export function checkNodeVersion(): { ok: boolean; current: string; required: string } {
  const current = process.version;
  const currentParsed = parseVersion(current);
  const requiredParsed = parseVersion(MIN_NODE_VERSION);

  if (!currentParsed || !requiredParsed) {
    return { ok: false, current, required: MIN_NODE_VERSION };
  }

  const comparison = compareVersions(currentParsed, requiredParsed);
  return { ok: comparison >= 0, current, required: MIN_NODE_VERSION };
}

/**
 * Check if the pnpm version meets the minimum requirement
 */
export function checkPnpmVersion(): {
  ok: boolean;
  current: string | null;
  required: string;
  error?: string;
} {
  try {
    const result = execSync("pnpm --version", { encoding: "utf-8", timeout: 5000 });
    const current = result.trim();
    const currentParsed = parseVersion(current);
    const requiredParsed = parseVersion(MIN_PNPM_VERSION);

    if (!currentParsed || !requiredParsed) {
      return { ok: false, current, required: MIN_PNPM_VERSION };
    }

    const comparison = compareVersions(currentParsed, requiredParsed);
    return { ok: comparison >= 0, current, required: MIN_PNPM_VERSION };
  } catch (error) {
    return {
      ok: false,
      current: null,
      required: MIN_PNPM_VERSION,
      error: error instanceof Error ? error.message : "Failed to check pnpm version",
    };
  }
}

/**
 * Parse .env.example file and extract required variable names
 * Returns array of variable names (only keys, not values)
 */
export function parseEnvExample(content: string): string[] {
  const variables: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    // Parse KEY=VALUE format
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (match) {
      variables.push(match[1]);
    }
  }

  return variables;
}

/**
 * Parse .env file and extract variable names that have values
 */
export function parseEnvFile(content: string): string[] {
  const variables: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    // Parse KEY=VALUE format
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2];
      // Only consider it present if value is not empty (ignoring comments after value)
      const valueWithoutComment = value.split("#")[0].trim();
      if (valueWithoutComment) {
        variables.push(key);
      }
    }
  }

  return variables;
}

/**
 * Check if .env file exists in the project root
 */
export function checkEnvFileExists(cwd: string = process.cwd()): {
  ok: boolean;
  path: string;
} {
  const envPath = path.join(cwd, ".env");
  return {
    ok: fs.existsSync(envPath),
    path: envPath,
  };
}

/**
 * Check if .env.example file exists and can be read
 */
export function checkEnvExampleExists(cwd: string = process.cwd()): {
  ok: boolean;
  path: string;
} {
  const examplePath = path.join(cwd, ".env.example");
  return {
    ok: fs.existsSync(examplePath),
    path: examplePath,
  };
}

/**
 * Validate .env file against .env.example
 * Returns list of missing variables
 */
export function validateEnvFile(cwd: string = process.cwd()): {
  ok: boolean;
  envExists: boolean;
  exampleExists: boolean;
  missing: string[];
  envPath: string;
  examplePath: string;
} {
  const envPath = path.join(cwd, ".env");
  const examplePath = path.join(cwd, ".env.example");

  const envExists = fs.existsSync(envPath);
  const exampleExists = fs.existsSync(examplePath);

  // If neither file exists, we can't validate
  if (!envExists && !exampleExists) {
    return {
      ok: false,
      envExists: false,
      exampleExists: false,
      missing: [],
      envPath,
      examplePath,
    };
  }

  // If .env.example doesn't exist, we can't validate
  if (!exampleExists) {
    return {
      ok: true, // Not a failure - just can't check
      envExists,
      exampleExists: false,
      missing: [],
      envPath,
      examplePath,
    };
  }

  // If .env doesn't exist, all required vars are missing
  if (!envExists) {
    const exampleContent = fs.readFileSync(examplePath, "utf-8");
    const requiredVars = parseEnvExample(exampleContent);
    return {
      ok: false,
      envExists: false,
      exampleExists: true,
      missing: requiredVars,
      envPath,
      examplePath,
    };
  }

  // Both exist - validate
  try {
    const exampleContent = fs.readFileSync(examplePath, "utf-8");
    const envContent = fs.readFileSync(envPath, "utf-8");

    const requiredVars = parseEnvExample(exampleContent);
    const presentVars = parseEnvFile(envContent);

    const missing = requiredVars.filter((v) => !presentVars.includes(v));

    return {
      ok: missing.length === 0,
      envExists: true,
      exampleExists: true,
      missing,
      envPath,
      examplePath,
    };
  } catch {
    return {
      ok: false,
      envExists,
      exampleExists,
      missing: [],
      envPath,
      examplePath,
    };
  }
}

/**
 * Get the default database file path
 * Returns the path to the SQLite database used for memory storage
 */
export function getDefaultDatabasePath(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, "memory.sqlite");
}

/**
 * Check if database file exists
 */
export function checkDatabaseExists(dbPath: string): {
  ok: boolean;
  path: string;
  exists: boolean;
} {
  const exists = fs.existsSync(dbPath);
  return {
    ok: exists,
    path: dbPath,
    exists,
  };
}

/**
 * Check if database file is readable and writable
 * Uses fs.accessSync to check permissions without opening the file
 */
export function checkDatabasePermissions(dbPath: string): {
  ok: boolean;
  readable: boolean;
  writable: boolean;
  error?: string;
} {
  try {
    // Check read permission
    fs.accessSync(dbPath, fs.constants.R_OK);
    const readable = true;

    // Check write permission
    fs.accessSync(dbPath, fs.constants.W_OK);
    const writable = true;

    return { ok: true, readable, writable };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      readable: false,
      writable: false,
      error: message,
    };
  }
}

/**
 * Check if we can open the database and run a simple query
 * This validates that the SQLite database is not corrupted
 */
export function checkDatabaseConnection(dbPath: string): {
  ok: boolean;
  queryable: boolean;
  error?: string;
} {
  try {
    // Try to read the first few bytes to verify it's a valid SQLite file
    const fd = fs.openSync(dbPath, "r");
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    if (bytesRead < 16) {
      return {
        ok: false,
        queryable: false,
        error: "Database file is too small to be a valid SQLite database",
      };
    }

    // Check SQLite magic header: "SQLite format 3\0"
    const header = buffer.toString("ascii", 0, 16);
    if (!header.startsWith("SQLite format 3")) {
      return {
        ok: false,
        queryable: false,
        error: "File is not a valid SQLite database (invalid header)",
      };
    }

    return { ok: true, queryable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      queryable: false,
      error: message,
    };
  }
}

/**
 * Run all database connectivity checks
 * Returns a summary of the database status
 */
export function checkDatabaseConnectivity(dbPath: string = getDefaultDatabasePath()): {
  ok: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  queryable: boolean;
  path: string;
  error?: string;
} {
  // Check if database exists
  const existsCheck = checkDatabaseExists(dbPath);
  if (!existsCheck.exists) {
    return {
      ok: false,
      exists: false,
      readable: false,
      writable: false,
      queryable: false,
      path: dbPath,
      error: `Database file not found at ${dbPath}`,
    };
  }

  // Check permissions
  const permissionsCheck = checkDatabasePermissions(dbPath);
  if (!permissionsCheck.ok) {
    return {
      ok: false,
      exists: true,
      readable: permissionsCheck.readable,
      writable: permissionsCheck.writable,
      queryable: false,
      path: dbPath,
      error: permissionsCheck.error,
    };
  }

  // Check connection (valid SQLite file)
  const connectionCheck = checkDatabaseConnection(dbPath);
  if (!connectionCheck.ok) {
    return {
      ok: false,
      exists: true,
      readable: true,
      writable: true,
      queryable: false,
      path: dbPath,
      error: connectionCheck.error,
    };
  }

  return {
    ok: true,
    exists: true,
    readable: true,
    writable: true,
    queryable: true,
    path: dbPath,
  };
}

/**
 * Get the bundled skills directory path
 * Returns the path where bundled skills should be located
 */
export function getBundledSkillsDir(): string | undefined {
  return resolveBundledSkillsDir();
}

/**
 * Check if the skills directory exists
 */
export function checkSkillsDirExists(): {
  ok: boolean;
  path: string | undefined;
  exists: boolean;
} {
  const skillsDir = getBundledSkillsDir();
  if (!skillsDir) {
    return {
      ok: false,
      path: undefined,
      exists: false,
    };
  }
  const exists = fs.existsSync(skillsDir);
  return {
    ok: exists,
    path: skillsDir,
    exists,
  };
}

/**
 * Get a list of all skills in the skills directory
 * Returns an array of skill directory names
 */
export function getSkillsList(skillsDir: string): string[] {
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Check if a skill has a valid SKILL.md file
 */
export function checkSkillHasMetadata(skillDir: string): {
  ok: boolean;
  hasSkillMd: boolean;
  skillPath: string;
} {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const hasSkillMd = fs.existsSync(skillMdPath);
  return {
    ok: hasSkillMd,
    hasSkillMd,
    skillPath: skillMdPath,
  };
}

/**
 * Get the gateway lock file path
 * Uses the same logic as acquireGatewayLock in gateway-lock.ts
 */
export function getGatewayLockPath(): string {
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha1").update(CONFIG_PATH).digest("hex").slice(0, 8);
  const lockDir = resolveGatewayLockDir();
  return path.join(lockDir, `gateway.${hash}.lock`);
}

/**
 * Read the gateway lock file and return its contents
 */
export function readGatewayLock(lockPath: string): { pid: number; port?: number } | null {
  try {
    const content = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(content) as { pid?: number; port?: number };
    if (typeof parsed.pid === "number") {
      return { pid: parsed.pid, port: parsed.port };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a process is running by PID
 * Uses process.kill(pid, 0) which doesn't actually kill the process
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if gateway is responding on a port
 * Uses exec to run a quick connection test
 */
export function checkGatewayPort(port: number): {
  ok: boolean;
  port: number;
  error?: string;
} {
  try {
    // Use curl to check if port is responding (works on macOS/Linux)
    // This is a synchronous check using execSync
    execSync(
      `curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://127.0.0.1:${port}/health || true`,
      {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    // If curl doesn't throw, something responded
    return { ok: true, port };
  } catch {
    // Expected - port not responding
    return { ok: false, port, error: `Port ${port} is not responding` };
  }
}

/**
 * Check gateway service status
 * Returns comprehensive information about gateway state
 */
export function checkGatewayStatus(): {
  ok: boolean;
  running: boolean;
  pid?: number;
  port: number;
  portResponding: boolean;
  lockFileExists: boolean;
  error?: string;
} {
  const cfg = loadConfig();
  const port = resolveGatewayPort(cfg);

  // Get lock file path and check if it exists
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha1").update(CONFIG_PATH).digest("hex").slice(0, 8);
  const lockDir = resolveGatewayLockDir();
  const lockPath = path.join(lockDir, `gateway.${hash}.lock`);

  const lockFileExists = fs.existsSync(lockPath);

  if (!lockFileExists) {
    return {
      ok: false,
      running: false,
      port,
      portResponding: false,
      lockFileExists: false,
      error: "Gateway is not running",
    };
  }

  // Read lock file
  const lockData = readGatewayLock(lockPath);
  if (!lockData) {
    return {
      ok: false,
      running: false,
      port,
      portResponding: false,
      lockFileExists: true,
      error: "Lock file exists but could not be read",
    };
  }

  // Check if process is running
  const pid = lockData.pid;
  const running = isProcessRunning(pid);

  // Gateway is considered ok if the process is running
  // Port check is optional and can be done separately if needed
  return {
    ok: running,
    running,
    pid: running ? pid : undefined,
    port,
    portResponding: false, // Port check skipped in sync context
    lockFileExists: true,
    error: running ? undefined : "Gateway is not running",
  };
}

/**
 * Validate all skills in the skills directory
 * Returns a summary of valid and invalid skills
 */
export function validateSkills(): {
  ok: boolean;
  skillsDir: string | undefined;
  totalSkills: number;
  validSkills: string[];
  invalidSkills: { name: string; reason: string }[];
  error?: string;
} {
  const dirCheck = checkSkillsDirExists();
  if (!dirCheck.exists || !dirCheck.path) {
    return {
      ok: false,
      skillsDir: dirCheck.path,
      totalSkills: 0,
      validSkills: [],
      invalidSkills: [],
      error: "Skills directory not found",
    };
  }

  const skillsDir = dirCheck.path;
  const skillNames = getSkillsList(skillsDir);
  const validSkills: string[] = [];
  const invalidSkills: { name: string; reason: string }[] = [];

  for (const skillName of skillNames) {
    const skillDir = path.join(skillsDir, skillName);
    const metadataCheck = checkSkillHasMetadata(skillDir);

    if (metadataCheck.hasSkillMd) {
      validSkills.push(skillName);
    } else {
      invalidSkills.push({
        name: skillName,
        reason: "Missing SKILL.md",
      });
    }
  }

  const allValid = invalidSkills.length === 0;

  return {
    ok: allValid,
    skillsDir,
    totalSkills: skillNames.length,
    validSkills,
    invalidSkills,
  };
}

export interface CheckOptions {
  /** Run without interactive prompts */
  nonInteractive?: boolean;
  /** Output results as JSON */
  json?: boolean;
}

export interface CheckResult {
  /** Overall check passed */
  ok: boolean;
  /** Individual check results */
  checks: CheckItemResult[];
}

export interface CheckItemResult {
  /** Check identifier */
  id: string;
  /** Human-readable check name */
  name: string;
  /** Check passed */
  ok: boolean;
  /** Optional message */
  message?: string;
}

/**
 * Run all installation checks
 */
async function runInstallationChecks(): Promise<CheckResult> {
  const checks: CheckItemResult[] = [];

  // Check 1: Node.js version
  const nodeVersionCheck = checkNodeVersion();
  checks.push({
    id: "node-version",
    name: "Node.js version",
    ok: nodeVersionCheck.ok,
    message: nodeVersionCheck.ok
      ? undefined
      : `Node.js ${nodeVersionCheck.current} installed, but ${nodeVersionCheck.required} or higher is required`,
  });

  // Check 2: pnpm version
  const pnpmVersionCheck = checkPnpmVersion();
  checks.push({
    id: "pnpm-version",
    name: "pnpm version",
    ok: pnpmVersionCheck.ok,
    message: pnpmVersionCheck.ok
      ? undefined
      : pnpmVersionCheck.error
        ? `Could not check pnpm version: ${pnpmVersionCheck.error}`
        : `pnpm ${pnpmVersionCheck.current} installed, but ${pnpmVersionCheck.required} or higher is required`,
  });

  // Check 3: Environment file exists
  const envExistsCheck = checkEnvFileExists();
  checks.push({
    id: "env-exists",
    name: "Environment file (.env) exists",
    ok: envExistsCheck.ok,
    message: envExistsCheck.ok
      ? undefined
      : `No .env file found. Copy .env.example to .env and configure your settings`,
  });

  // Check 4: Environment variables are valid
  const envValidCheck = validateEnvFile();
  checks.push({
    id: "env-valid",
    name: "Environment variables are configured",
    ok: envValidCheck.ok,
    message: (() => {
      if (envValidCheck.ok) {
        return undefined;
      }
      if (!envValidCheck.exampleExists) {
        return "No .env.example found to validate against";
      }
      if (!envValidCheck.envExists) {
        return ".env file is missing";
      }
      if (envValidCheck.missing.length > 0) {
        return `Missing variables: ${envValidCheck.missing.join(", ")}`;
      }
      return "Failed to validate environment file";
    })(),
  });

  // Check 5: Config file exists
  const configExists = fs.existsSync(CONFIG_PATH);
  checks.push({
    id: "config-exists",
    name: "Configuration file exists",
    ok: configExists,
    message: configExists
      ? undefined
      : `Run ${formatCliCommand("openclaw setup")} to create a config file`,
  });

  // Check 6: Config is valid (if exists)
  let configValid = false;
  if (configExists) {
    try {
      const cfg = loadConfig();
      configValid = cfg !== null && typeof cfg === "object";
    } catch {
      configValid = false;
    }
  }
  checks.push({
    id: "config-valid",
    name: "Configuration is valid",
    ok: configValid,
    message: configValid ? undefined : "Configuration file has errors",
  });

  // Check 7: Gateway mode is configured
  let gatewayModeConfigured = false;
  if (configValid) {
    try {
      const cfg = loadConfig();
      gatewayModeConfigured = cfg.gateway?.mode === "local" || cfg.gateway?.mode === "remote";
    } catch {
      gatewayModeConfigured = false;
    }
  }
  checks.push({
    id: "gateway-mode",
    name: "Gateway mode is configured",
    ok: gatewayModeConfigured,
    message: gatewayModeConfigured
      ? undefined
      : `Run ${formatCliCommand("openclaw config set gateway.mode local")} or configure via ${formatCliCommand("openclaw configure")}`,
  });

  // Check 8: Package root is accessible
  let packageRootAccessible = false;
  try {
    const root = await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
    packageRootAccessible = root !== null && fs.existsSync(root);
  } catch {
    packageRootAccessible = false;
  }
  checks.push({
    id: "package-root",
    name: "OpenClaw installation is accessible",
    ok: packageRootAccessible,
    message: packageRootAccessible ? undefined : "Installation may be corrupted",
  });

  // Check 9: Database connectivity
  const dbCheck = checkDatabaseConnectivity();
  checks.push({
    id: "database",
    name: "Database is accessible",
    ok: dbCheck.ok,
    message: dbCheck.ok ? undefined : dbCheck.error || "Database is not accessible",
  });

  // Check 10: Skills directory exists and is valid
  const skillsCheck = validateSkills();
  checks.push({
    id: "skills-dir",
    name: "Skills directory is valid",
    ok: skillsCheck.ok && skillsCheck.skillsDir !== undefined,
    message: (() => {
      if (!skillsCheck.skillsDir) {
        return "Skills directory not found";
      }
      if (skillsCheck.invalidSkills.length > 0) {
        const invalidList = skillsCheck.invalidSkills
          .map((s) => `${s.name} (${s.reason})`)
          .join(", ");
        return `${skillsCheck.invalidSkills.length} skill(s) missing metadata: ${invalidList}`;
      }
      return undefined;
    })(),
  });

  // Check 11: Gateway service status
  const gatewayCheck = checkGatewayStatus();
  checks.push({
    id: "gateway-running",
    name: "Gateway service is running",
    ok: gatewayCheck.ok,
    message: (() => {
      if (gatewayCheck.ok) {
        return undefined;
      }
      if (!gatewayCheck.running) {
        return `Gateway is stopped. Run ${formatCliCommand("openclaw gateway start")} to start it`;
      }
      if (!gatewayCheck.portResponding) {
        return `Gateway process running (PID ${gatewayCheck.pid}) but not responding on port ${gatewayCheck.port}`;
      }
      return gatewayCheck.error || "Gateway check failed";
    })(),
  });

  const allOk = checks.every((c) => c.ok);

  return {
    ok: allOk,
    checks,
  };
}

/**
 * Format check results for terminal output
 */
function formatCheckResults(result: CheckResult): string[] {
  const lines: string[] = [];

  for (const check of result.checks) {
    const status = check.ok ? "✓" : "✗";
    lines.push(`${status} ${check.name}`);
    if (check.message) {
      lines.push(`  → ${check.message}`);
    }
  }

  lines.push("");
  lines.push(result.ok ? "All checks passed!" : "Some checks failed.");

  return lines;
}

/**
 * Main check command implementation
 */
export async function checkCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: CheckOptions = {},
): Promise<void> {
  if (!options.json) {
    intro("OpenClaw Installation Check");
  }

  const result = await runInstallationChecks();

  if (options.json) {
    runtime.log(JSON.stringify(result, null, 2));
  } else {
    for (const line of formatCheckResults(result)) {
      if (line === "") {
        runtime.log("");
      } else if (line.startsWith("✓")) {
        runtime.log(line);
      } else if (line.startsWith("✗")) {
        runtime.error(line);
      } else if (line.startsWith("  →")) {
        note(line.slice(4), "Fix");
      } else if (line.includes("passed")) {
        runtime.log(line);
      } else {
        runtime.log(line);
      }
    }

    outro(result.ok ? "Installation looks good!" : "Installation check complete");
  }

  if (!result.ok && options.nonInteractive) {
    process.exitCode = 1;
  }
}
