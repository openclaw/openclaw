import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig, CONFIG_PATH } from "../config/config.js";
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
