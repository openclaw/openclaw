import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { execSync } from "node:child_process";
import fs from "node:fs";
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

  // Check 3: Config file exists
  const configExists = fs.existsSync(CONFIG_PATH);
  checks.push({
    id: "config-exists",
    name: "Configuration file exists",
    ok: configExists,
    message: configExists
      ? undefined
      : `Run ${formatCliCommand("openclaw setup")} to create a config file`,
  });

  // Check 2: Config is valid (if exists)
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

  // Check 3: Gateway mode is configured
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

  // Check 4: Package root is accessible
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
