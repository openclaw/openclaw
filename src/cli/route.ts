// Route-first CLI entry point for commands that can run before full Commander setup.
import { isTruthyEnvValue } from "../infra/env.js";
import { tryParseLogLevel } from "../logging/levels.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag } from "./argv.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
  resolveCliExecutionStartupContext,
} from "./command-execution-startup.js";
import { findRoutedCommand } from "./program/routes.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean | ((argv: string[]) => boolean);
}) {
  const { startupPolicy } = resolveCliExecutionStartupContext({
    argv: params.argv,
    jsonOutputMode: hasFlag(params.argv, "--json"),
    env: process.env,
    routeMode: true,
  });
  const { VERSION } = await import("../version.js");
  await applyCliExecutionStartupPresentation({
    argv: params.argv,
    startupPolicy,
    showBanner: process.stdout.isTTY && !startupPolicy.suppressDoctorStdout,
    version: VERSION,
  });
  const shouldLoadPlugins =
    typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;
  // Routed commands still honor config guards, logging policy, and plugin loading decisions.
  await ensureCliExecutionBootstrap({
    runtime: defaultRuntime,
    commandPath: params.commandPath,
    startupPolicy,
    loadPlugins: shouldLoadPlugins ?? startupPolicy.loadPlugins,
  });
}

/**
 * Extract the last valid `--log-level` value from route-first argv.
 * Returns `undefined` when the flag is absent, `null` when any occurrence is
 * missing/invalid (so the caller can fall back to Commander), or the parsed
 * level string when all occurrences are valid.
 */
function parseRouteFirstLogLevel(argv: string[]): string | null | undefined {
  let lastValid: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log-level") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.startsWith("-")) {
        // Missing value — let Commander own the error.
        return null;
      }
      if (!tryParseLogLevel(next)) {
        return null;
      }
      lastValid = next;
    }
  }
  return lastValid;
}

/** Try a lightweight route-first command before falling back to the full CLI program. */
export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  if (!invocation.commandPath[0]) {
    return false;
  }
  const route = findRoutedCommand(invocation.commandPath, argv);
  if (!route) {
    return false;
  }
  if (route.canRun && !route.canRun(argv)) {
    // Let Commander own unsupported argv shapes so user-facing validation stays centralized.
    return false;
  }
  // Apply --log-level before bootstrap so route-first commands honor it the
  // same way Commander-backed commands do via preAction.
  const routeFirstLogLevel = parseRouteFirstLogLevel(argv);
  if (routeFirstLogLevel === null) {
    // Invalid/missing value — fall back to Commander for validation.
    return false;
  }
  if (routeFirstLogLevel) {
    process.env.OPENCLAW_LOG_LEVEL = routeFirstLogLevel;
  }
  await prepareRoutedCommand({
    argv,
    commandPath: invocation.commandPath,
    loadPlugins: route.loadPlugins,
  });
  return route.run(argv);
}
