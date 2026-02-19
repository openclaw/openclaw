import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { detectRuntime, isSupportedNodeVersion, type RuntimeDetails } from "../infra/runtime-guard.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import type { RuntimeEnv } from "../runtime.js";

export type PreflightCheck = {
  name: string;
  check: () => Promise<PreflightResult>;
  required: boolean;
  fixHint?: string;
};

export type PreflightResult = {
  ok: boolean;
  message?: string;
  fixHint?: string;
};

export type PreflightReport = {
  allPassed: boolean;
  checks: Array<{
    name: string;
    result: PreflightResult;
    required: boolean;
  }>;
  summary: string;
};

/**
 * Check Node.js version meets requirements.
 */
async function checkNodeVersion(): Promise<PreflightResult> {
  const runtime: RuntimeDetails = detectRuntime();
  const supported = isSupportedNodeVersion(runtime.version);

  if (!supported) {
    return {
      ok: false,
      message: `Node.js version ${runtime.version ?? "unknown"} is below minimum requirement (22.12.0)`,
      fixHint: "Install or upgrade Node.js: https://nodejs.org/en/download",
    };
  }

  return {
    ok: true,
    message: `Node.js ${runtime.version} meets requirements`,
  };
}

/**
 * Check network connectivity for OAuth flows.
 */
async function checkNetworkConnectivity(): Promise<PreflightResult> {
  const testUrls = [
    "https://api.anthropic.com",
    "https://api.openai.com",
  ];

  for (const url of testUrls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok || response.status === 405) {
        // 405 Method Not Allowed is fine - means server is reachable
        return {
          ok: true,
          message: "Network connectivity verified",
        };
      }
    } catch (error) {
      // Continue to next URL
      if (error instanceof Error && error.name === "AbortError") {
        continue;
      }
    }
  }

  return {
    ok: false,
    message: "Cannot reach API endpoints (OAuth flows may fail)",
    fixHint: "Check your internet connection and firewall settings",
  };
}

/**
 * Check file system permissions for config directory.
 */
async function checkConfigPermissions(): Promise<PreflightResult> {
  try {
    const configDir = resolveStateDir();
    await fs.access(configDir, fs.constants.R_OK | fs.constants.W_OK);
    return {
      ok: true,
      message: `Config directory accessible: ${configDir}`,
    };
  } catch (error) {
    const configDir = resolveStateDir();
    return {
      ok: false,
      message: `Cannot access config directory: ${configDir}`,
      fixHint: `Ensure you have read/write permissions: chmod 755 ${configDir}`,
    };
  }
}

/**
 * Check workspace directory permissions.
 */
async function checkWorkspacePermissions(): Promise<PreflightResult> {
  try {
    const workspacePath = resolveUserPath(DEFAULT_AGENT_WORKSPACE_DIR);
    const workspaceDir = path.dirname(workspacePath);

    // Check if parent directory exists and is writable
    await fs.access(workspaceDir, fs.constants.R_OK | fs.constants.W_OK);

    // Try to create workspace directory if it doesn't exist
    try {
      await fs.mkdir(workspacePath, { recursive: true });
    } catch {
      // Directory might already exist, that's fine
    }

    // Verify we can write to it
    const testFile = path.join(workspacePath, ".preflight-test");
    try {
      await fs.writeFile(testFile, "test");
      await fs.unlink(testFile);
    } catch {
      return {
        ok: false,
        message: `Cannot write to workspace directory: ${workspacePath}`,
        fixHint: `Ensure you have write permissions: chmod 755 ${workspaceDir}`,
      };
    }

    return {
      ok: true,
      message: `Workspace directory accessible: ${workspacePath}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Cannot access workspace directory: ${DEFAULT_AGENT_WORKSPACE_DIR}`,
      fixHint: `Ensure the directory exists and is writable`,
    };
  }
}

/**
 * Check if a port is available.
 */
async function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once("close", () => resolve(true));
      server.close();
    });
    server.on("error", () => resolve(false));
  });
}

/**
 * Check default gateway port availability.
 */
async function checkGatewayPort(): Promise<PreflightResult> {
  const defaultPort = 18789;
  const available = await checkPortAvailable(defaultPort);

  if (!available) {
    return {
      ok: false,
      message: `Default gateway port ${defaultPort} is already in use`,
      fixHint: `Stop the service using port ${defaultPort} or configure a different port during onboarding`,
    };
  }

  return {
    ok: true,
    message: `Gateway port ${defaultPort} is available`,
  };
}

/**
 * Check existing config file validity.
 */
async function checkExistingConfig(): Promise<PreflightResult> {
  const snapshot = await readConfigFileSnapshot();

  if (!snapshot.exists) {
    return {
      ok: true,
      message: "No existing config file found (will create new)",
    };
  }

  if (!snapshot.valid) {
    const issues = snapshot.issues.map((iss) => `${iss.path}: ${iss.message}`).join("; ");
    return {
      ok: false,
      message: `Existing config file is invalid: ${issues}`,
      fixHint: `Run \`openclaw doctor\` to repair the config, or delete ${snapshot.path} to start fresh`,
    };
  }

  return {
    ok: true,
    message: "Existing config file is valid",
  };
}

/**
 * Run all preflight checks.
 */
export async function runPreflightChecks(
  options: {
    skipNetwork?: boolean;
    skipPort?: boolean;
  } = {},
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [
    {
      name: "Node.js version",
      check: checkNodeVersion,
      required: true,
    },
    {
      name: "Config directory permissions",
      check: checkConfigPermissions,
      required: true,
    },
    {
      name: "Workspace directory permissions",
      check: checkWorkspacePermissions,
      required: true,
    },
    {
      name: "Network connectivity",
      check: checkNetworkConnectivity,
      required: false,
      fixHint: "OAuth flows may fail without network access",
    },
    {
      name: "Gateway port availability",
      check: checkGatewayPort,
      required: false,
      fixHint: "You can configure a different port during onboarding",
    },
    {
      name: "Existing config validity",
      check: checkExistingConfig,
      required: false,
      fixHint: "Invalid config will be handled during onboarding",
    },
  ];

  const results: PreflightReport["checks"] = [];

  for (const check of checks) {
    // Skip optional checks if requested
    if (check.name === "Network connectivity" && options.skipNetwork) {
      continue;
    }
    if (check.name === "Gateway port availability" && options.skipPort) {
      continue;
    }

    const result = await check.check();
    results.push({
      name: check.name,
      result: {
        ...result,
        fixHint: result.fixHint ?? check.fixHint,
      },
      required: check.required,
    });
  }

  const failedRequired = results.filter((r) => r.required && !r.result.ok);
  const allPassed = failedRequired.length === 0;

  const summary = allPassed
    ? "All preflight checks passed"
    : `${failedRequired.length} required check(s) failed`;

  return {
    allPassed,
    checks: results,
    summary,
  };
}

/**
 * Format preflight report for display.
 */
export function formatPreflightReport(
  report: PreflightReport,
  runtime: RuntimeEnv,
): string {
  const lines: string[] = [];
  lines.push("Preflight checks:");
  lines.push("");

  for (const check of report.checks) {
    const status = check.result.ok ? "✓" : "✗";
    const required = check.required ? "(required)" : "(optional)";
    lines.push(`${status} ${check.name} ${required}`);

    if (check.result.message) {
      lines.push(`  ${check.result.message}`);
    }

    if (!check.result.ok && check.result.fixHint) {
      lines.push(`  Fix: ${check.result.fixHint}`);
    }

    lines.push("");
  }

  if (!report.allPassed) {
    const failed = report.checks.filter((c) => !c.result.ok && c.required);
    if (failed.length > 0) {
      lines.push(`Failed required checks: ${failed.map((c) => c.name).join(", ")}`);
      lines.push("Please fix these issues before continuing.");
    }
  }

  return lines.join("\n");
}
