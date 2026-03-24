import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { scheduleDetachedLaunchdRestartHandoff } from "../daemon/launchd-restart-handoff.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { triggerOpenClawRestart } from "./restart.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";

type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";
const OPENCLAW_RUNNER_RUNTIME_CWD = "OPENCLAW_RUNNER_RUNTIME_CWD";
const OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV = "OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV";
const OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS = "OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS";

export type GatewayRespawnResult = {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
};

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeArgPath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function looksLikeDevEntrypoint(argv1: string): boolean {
  const normalized = normalizeArgPath(argv1);
  return normalized.endsWith("/src/entry.ts") || normalized.endsWith("/src/index.ts");
}

function resolveStableSourceTreeEntrypoint(packageRoot: string): string | null {
  if (isBunRespawnRuntime()) {
    return null;
  }

  const runNodePath = path.join(packageRoot, "scripts", "run-node.mjs");
  const sourceEntryPath = path.join(packageRoot, "src", "entry.ts");
  const tsconfigPath = path.join(packageRoot, "tsconfig.json");
  if (existsSync(runNodePath) && existsSync(sourceEntryPath) && existsSync(tsconfigPath)) {
    return runNodePath;
  }

  return null;
}

function isBunRespawnRuntime(): boolean {
  const execBase = path.basename(process.execPath ?? "").toLowerCase();
  return execBase === "bun" || execBase === "bun.exe" || Boolean(process.versions?.bun);
}

function resolveStableDistEntrypoint(packageRoot: string, argv1: string): string | null {
  const currentBasename = path.basename(argv1);
  const candidates = Array.from(
    new Set([currentBasename, "entry.js", "entry.mjs", "index.js", "index.mjs"]),
  );
  for (const candidate of candidates) {
    const candidatePath = path.join(packageRoot, "dist", candidate);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

function resolveStablePackageEntrypoint(packageRoot: string, argv1: string): string | null {
  const sourceTreeEntrypoint = resolveStableSourceTreeEntrypoint(packageRoot);
  if (sourceTreeEntrypoint) {
    return sourceTreeEntrypoint;
  }

  if (isBunRespawnRuntime()) {
    return resolveStableDistEntrypoint(packageRoot, argv1);
  }

  const wrapperPath = path.join(packageRoot, "openclaw.mjs");
  if (existsSync(wrapperPath)) {
    return wrapperPath;
  }

  return resolveStableDistEntrypoint(packageRoot, argv1);
}

function resolvePnpmStableEntrypointFromArgv1(argv1: string): {
  packageRoot: string;
  entrypoint: string;
} | null {
  const normalized = path.resolve(argv1);
  const marker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const suffix = normalized.slice(markerIndex + marker.length);
  const suffixParts = suffix.split(path.sep);
  if (suffixParts.length < 3) {
    return null;
  }
  if (suffixParts[1] !== "node_modules" || suffixParts[2] !== "openclaw") {
    return null;
  }

  const stableRoot = path.join(normalized.slice(0, markerIndex), "node_modules", "openclaw");
  const entrypoint = resolveStablePackageEntrypoint(stableRoot, argv1);
  if (!entrypoint) {
    return null;
  }
  return {
    packageRoot: stableRoot,
    entrypoint,
  };
}

function isInspectorExecArgv(value: string): boolean {
  return (
    value === "--inspect" ||
    value.startsWith("--inspect=") ||
    value.startsWith("--inspect-") ||
    value === "--debug-port" ||
    value.startsWith("--debug-port=")
  );
}

function inspectorExecArgvConsumesNextValue(value: string): boolean {
  return (
    value === "--inspect-port" || value === "--inspect-publish-uid" || value === "--debug-port"
  );
}

function isWatchExecArgv(value: string): boolean {
  return (
    value === "--watch" ||
    value.startsWith("--watch=") ||
    value === "--watch-path" ||
    value.startsWith("--watch-path=") ||
    value === "--watch-kill-signal" ||
    value.startsWith("--watch-kill-signal=") ||
    value === "--watch-preserve-output"
  );
}

function watchExecArgvConsumesNextValue(value: string): boolean {
  return value === "--watch-path" || value === "--watch-kill-signal";
}

function isPreloadExecArgv(value: string): boolean {
  return (
    value === "--import" ||
    value.startsWith("--import=") ||
    value === "--require" ||
    value.startsWith("--require=") ||
    value === "-r" ||
    value === "--loader" ||
    value.startsWith("--loader=") ||
    value === "--experimental-loader" ||
    value.startsWith("--experimental-loader=")
  );
}

function stripIntermediateExecArgv(execArgv: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const value = execArgv[index];
    if (isInspectorExecArgv(value) || isWatchExecArgv(value)) {
      if (inspectorExecArgvConsumesNextValue(value) || watchExecArgvConsumesNextValue(value)) {
        index += 1;
      }
      continue;
    }
    if (isPreloadExecArgv(value)) {
      if (!value.includes("=")) {
        index += 1;
      }
      continue;
    }
    stripped.push(value);
  }
  return stripped;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function tokenizeNodeOptions(value: string): string[] {
  return (value.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) ?? []).map((token) =>
    stripOuterQuotes(token),
  );
}

function formatNodeOptions(tokens: string[]): string | undefined {
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens
    .map((token) => {
      if (!/\s/.test(token) && !token.includes('"')) {
        return token;
      }
      return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    })
    .join(" ");
}

function stripIntermediateNodeOptions(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const tokens = tokenizeNodeOptions(value);
  const stripped: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isInspectorExecArgv(token) || isWatchExecArgv(token)) {
      if (inspectorExecArgvConsumesNextValue(token) || watchExecArgvConsumesNextValue(token)) {
        index += 1;
      }
      continue;
    }
    if (isPreloadExecArgv(token)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    stripped.push(token);
  }
  return formatNodeOptions(stripped);
}

function buildSourceTreeRespawnPlan(packageRoot: string): {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  const wrapperExecArgv = stripIntermediateExecArgv(process.execArgv);
  const runtimeCwd = process.cwd();
  const wrapperNodeOptions = stripIntermediateNodeOptions(process.env.NODE_OPTIONS);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [OPENCLAW_RUNNER_RUNTIME_CWD]: runtimeCwd,
    [OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV]: JSON.stringify(process.execArgv),
  };
  if (typeof process.env.NODE_OPTIONS === "string" && process.env.NODE_OPTIONS.trim()) {
    env[OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS] = process.env.NODE_OPTIONS;
  }
  if (wrapperNodeOptions) {
    env.NODE_OPTIONS = wrapperNodeOptions;
  } else {
    delete env.NODE_OPTIONS;
  }
  return {
    args: [
      ...wrapperExecArgv,
      path.join(packageRoot, "scripts", "run-node.mjs"),
      ...process.argv.slice(2),
    ],
    cwd: runtimeCwd,
    env,
  };
}

function resolveStableRespawnPlan(): {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} {
  const currentArgs = [...process.execArgv, ...process.argv.slice(1)];
  const argv1 = process.argv[1]?.trim();
  if (!argv1 || looksLikeDevEntrypoint(argv1)) {
    return { args: currentArgs };
  }

  const pnpmRespawnTarget = resolvePnpmStableEntrypointFromArgv1(argv1);
  if (pnpmRespawnTarget) {
    const sourceTreeEntrypoint = resolveStableSourceTreeEntrypoint(pnpmRespawnTarget.packageRoot);
    if (sourceTreeEntrypoint && pnpmRespawnTarget.entrypoint === sourceTreeEntrypoint) {
      return buildSourceTreeRespawnPlan(pnpmRespawnTarget.packageRoot);
    }
    return { args: [...process.execArgv, pnpmRespawnTarget.entrypoint, ...process.argv.slice(2)] };
  }

  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    cwd: process.cwd(),
  });
  if (!packageRoot) {
    return { args: currentArgs };
  }

  const sourceTreeEntrypoint = resolveStableSourceTreeEntrypoint(packageRoot);
  if (sourceTreeEntrypoint) {
    return buildSourceTreeRespawnPlan(packageRoot);
  }

  const stableEntrypoint = resolveStablePackageEntrypoint(packageRoot, argv1);
  if (!stableEntrypoint) {
    return { args: currentArgs };
  }

  return { args: [...process.execArgv, stableEntrypoint, ...process.argv.slice(2)] };
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - otherwise: spawn detached child with current argv/execArgv, then caller exits
 */
export function restartGatewayProcessWithFreshPid(): GatewayRespawnResult {
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled" };
  }
  const supervisor = detectRespawnSupervisor(process.env);
  if (supervisor) {
    // Hand off launchd restarts to a detached helper before exiting so config
    // reloads and SIGUSR1-driven restarts do not depend on exit/respawn timing.
    if (supervisor === "launchd") {
      const handoff = scheduleDetachedLaunchdRestartHandoff({
        env: process.env,
        mode: "start-after-exit",
        waitForPid: process.pid,
      });
      if (!handoff.ok) {
        return {
          mode: "supervised",
          detail: `launchd exit fallback (${handoff.detail ?? "restart handoff failed"})`,
        };
      }
      return {
        mode: "supervised",
        detail: `launchd restart handoff pid ${handoff.pid ?? "unknown"}`,
      };
    }
    if (supervisor === "schtasks") {
      const restart = triggerOpenClawRestart();
      if (!restart.ok) {
        return {
          mode: "failed",
          detail: restart.detail ?? `${restart.method} restart failed`,
        };
      }
    }
    return { mode: "supervised" };
  }
  if (process.platform === "win32") {
    // Detached respawn is unsafe on Windows without an identified Scheduled Task:
    // the child becomes orphaned if the original process exits.
    return {
      mode: "disabled",
      detail: "win32: detached respawn unsupported without Scheduled Task markers",
    };
  }

  try {
    const plan = resolveStableRespawnPlan();
    const child = spawn(process.execPath, plan.args, {
      cwd: plan.cwd,
      env: plan.env ?? process.env,
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    return { mode: "spawned", pid: child.pid ?? undefined };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { mode: "failed", detail };
  }
}
