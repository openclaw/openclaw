import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { scheduleDetachedLaunchdRestartHandoff } from "../daemon/launchd-restart-handoff.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { triggerOpenClawRestart } from "./restart.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";

type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";

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
  if (isBunRespawnRuntime()) {
    return resolveStableDistEntrypoint(packageRoot, argv1);
  }

  const wrapperPath = path.join(packageRoot, "openclaw.mjs");
  if (existsSync(wrapperPath)) {
    return wrapperPath;
  }

  return resolveStableDistEntrypoint(packageRoot, argv1);
}

function resolvePnpmStableEntrypointFromArgv1(argv1: string): string | null {
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
  return resolveStablePackageEntrypoint(stableRoot, argv1);
}

function resolveStableRespawnArgs(): string[] {
  const currentArgs = [...process.execArgv, ...process.argv.slice(1)];
  const argv1 = process.argv[1]?.trim();
  if (!argv1 || looksLikeDevEntrypoint(argv1)) {
    return currentArgs;
  }

  const pnpmEntrypoint = resolvePnpmStableEntrypointFromArgv1(argv1);
  if (pnpmEntrypoint) {
    return [...process.execArgv, pnpmEntrypoint, ...process.argv.slice(2)];
  }

  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    cwd: process.cwd(),
  });
  if (!packageRoot) {
    return currentArgs;
  }

  const stableEntrypoint = resolveStablePackageEntrypoint(packageRoot, argv1);
  if (!stableEntrypoint) {
    return currentArgs;
  }

  return [...process.execArgv, stableEntrypoint, ...process.argv.slice(2)];
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
    const args = resolveStableRespawnArgs();
    const child = spawn(process.execPath, args, {
      env: process.env,
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
