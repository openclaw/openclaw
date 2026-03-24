import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { confirm, isCancel, spinner } from "@clack/prompts";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { stylePromptMessage } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import { DENCHCLAW_DEFAULT_GATEWAY_PORT, isDaemonlessMode } from "../config/paths.js";
import { VERSION } from "../version.js";
import { applyCliProfileEnv } from "./profile.js";
import {
  DEFAULT_WEB_APP_PORT,
  cleanupManagedWebRuntimeBackup,
  ensureManagedWebRuntime,
  evaluateMajorVersionTransition,
  readLastKnownWebPort,
  readLastLogLines,
  readManagedWebRuntimeManifest,
  resolveCliPackageRoot,
  resolveManagedWebRuntimeServerPath,
  resolveOpenClawCommandOrThrow,
  resolveProfileStateDir,
  runOpenClawCommand,
  startManagedWebRuntime,
  stopManagedWebRuntime,
  waitForWebRuntime,
} from "./web-runtime.js";
import {
  installWebRuntimeLaunchAgent,
  uninstallWebRuntimeLaunchAgent,
} from "./web-runtime-launchd.js";
import { discoverWorkspaceDirs, syncManagedSkills, type SkillSyncResult } from "./workspace-seed.js";

type SpawnResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type UpdateWebRuntimeOptions = {
  profile?: string;
  webPort?: string | number;
  nonInteractive?: boolean;
  yes?: boolean;
  noOpen?: boolean;
  json?: boolean;
  skipDaemonInstall?: boolean;
};

export type StopWebRuntimeOptions = {
  profile?: string;
  webPort?: string | number;
  json?: boolean;
  skipDaemonInstall?: boolean;
};

export type StartWebRuntimeOptions = {
  profile?: string;
  webPort?: string | number;
  noOpen?: boolean;
  json?: boolean;
  skipDaemonInstall?: boolean;
};

export type UpdateWebRuntimeSummary = {
  profile: string;
  webPort: number;
  version: string;
  majorGate: {
    required: boolean;
    previousVersion?: string;
    currentVersion: string;
  };
  stoppedPids: number[];
  skippedForeignPids: number[];
  ready: boolean;
  reason: string;
  gatewayRestarted: boolean;
  gatewayError?: string;
  skillSync: SkillSyncResult;
};

export type StopWebRuntimeSummary = {
  profile: string;
  webPort: number;
  stoppedPids: number[];
  skippedForeignPids: number[];
};

export type StartWebRuntimeSummary = {
  profile: string;
  webPort: number;
  stoppedPids: number[];
  skippedForeignPids: number[];
  started: boolean;
  reason: string;
  gatewayRestarted: boolean;
  gatewayError?: string;
};

function parseOptionalPort(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function firstNonEmptyLine(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const first = value
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }
  return undefined;
}

async function openUrl(url: string): Promise<boolean> {
  const argv =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const [cmd, ...args] = argv;
  if (!cmd) return false;
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function promptAndOpenWebUi(params: {
  webPort: number;
  json?: boolean;
  noOpen?: boolean;
  runtime: RuntimeEnv;
}): Promise<void> {
  if (params.noOpen || params.json || !process.stdin.isTTY) return;
  const webUrl = `http://localhost:${params.webPort}`;
  const wantOpen = await confirm({
    message: stylePromptMessage(`Open ${webUrl} in your browser?`),
    initialValue: true,
  });
  if (isCancel(wantOpen) || !wantOpen) return;
  const opened = await openUrl(webUrl);
  if (!opened) {
    params.runtime.log(theme.muted("Browser open failed; copy/paste the URL above."));
  }
}

async function runOpenClawUpdateWithProgress(openclawCommand: string): Promise<void> {
  const s = spinner();
  s.start("Updating OpenClaw (required for this major Dench upgrade)...");
  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(openclawCommand, ["update", "--yes"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, 8 * 60_000);

    const updateSpinner = (chunk: string) => {
      const line = chunk
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
        .at(-1);
      if (line) {
        s.message(line.length > 72 ? `${line.slice(0, 69)}...` : line);
      }
    };

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      updateSpinner(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      updateSpinner(text);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });

  if (result.code === 0) {
    s.stop("OpenClaw update complete.");
    return;
  }
  const detail = firstNonEmptyLine(result.stderr, result.stdout);
  s.stop(detail ? `OpenClaw update failed: ${detail}` : "OpenClaw update failed.");
  throw new Error(
    detail
      ? `OpenClaw update failed.\n${detail}`
      : "OpenClaw update failed. Fix this before running `npx denchclaw update` again.",
  );
}

async function ensureMajorUpgradeAcknowledged(params: {
  required: boolean;
  previousVersion: string | undefined;
  currentVersion: string;
  nonInteractive: boolean;
  yes: boolean;
  runtime: RuntimeEnv;
}): Promise<void> {
  if (!params.required) {
    return;
  }

  if (params.nonInteractive || !process.stdin.isTTY) {
    if (!params.yes) {
      throw new Error(
        `Major Dench upgrade detected (${params.previousVersion ?? "unknown"} -> ${params.currentVersion}). Re-run with --yes to approve the required OpenClaw update.`,
      );
    }
    return;
  }

  if (params.yes) {
    return;
  }

  const decision = await confirm({
    message: stylePromptMessage(
      `Major Dench upgrade detected (${params.previousVersion ?? "unknown"} -> ${params.currentVersion}). Continue with mandatory OpenClaw update now?`,
    ),
    initialValue: true,
  });
  if (isCancel(decision) || !decision) {
    params.runtime.log(
      theme.warn("Update cancelled. OpenClaw update is required for major upgrades."),
    );
    throw new Error("Major upgrade requires OpenClaw update approval.");
  }
}

function resolveGatewayPort(stateDir: string): number {
  const manifest = readManagedWebRuntimeManifest(stateDir);
  if (
    typeof manifest?.lastGatewayPort === "number" &&
    Number.isFinite(manifest.lastGatewayPort) &&
    manifest.lastGatewayPort > 0
  ) {
    return manifest.lastGatewayPort;
  }

  for (const name of ["openclaw.json", "config.json"]) {
    const port = readConfigGatewayPort(path.join(stateDir, name));
    if (typeof port === "number") {
      return port;
    }
  }
  return DENCHCLAW_DEFAULT_GATEWAY_PORT;
}

function readConfigGatewayPort(configPath: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
      gateway?: { port?: unknown };
    };
    const parsedPort =
      typeof raw.gateway?.port === "number"
        ? raw.gateway.port
        : typeof raw.gateway?.port === "string"
          ? Number.parseInt(raw.gateway.port, 10)
          : undefined;
    if (typeof parsedPort === "number" && Number.isFinite(parsedPort) && parsedPort > 0) {
      return parsedPort;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function restartGatewayDaemon(params: {
  profile: string;
  gatewayPort: number;
  json: boolean;
}): Promise<{ restarted: boolean; error?: string }> {
  let openclawCommand: string;
  try {
    openclawCommand = resolveOpenClawCommandOrThrow();
  } catch {
    return { restarted: false, error: "openclaw CLI not found on PATH" };
  }

  const s = !params.json ? spinner() : null;
  s?.start("Refreshing gateway service definition…");

  await runOpenClawCommand({
    openclawCommand,
    args: ["--profile", params.profile, "gateway", "install", "--force"],
    timeoutMs: 2 * 60_000,
  }).catch(() => ({ code: 1, stdout: "", stderr: "install failed" }));

  s?.message("Restarting gateway daemon…");
  const restartResult = await runOpenClawCommand({
    openclawCommand,
    args: ["--profile", params.profile, "gateway", "restart"],
    timeoutMs: 2 * 60_000,
  }).catch(() => ({ code: 1, stdout: "", stderr: "restart failed" }));

  if (restartResult.code !== 0) {
    const detail = firstNonEmptyLine(restartResult.stderr, restartResult.stdout);
    s?.stop(detail ? `Gateway restart failed: ${detail}` : "Gateway restart failed.");
    return { restarted: false, error: detail ?? "gateway restart failed" };
  }

  s?.stop("Gateway daemon restarted.");
  return { restarted: true };
}

export async function updateWebRuntimeCommand(
  opts: UpdateWebRuntimeOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<UpdateWebRuntimeSummary> {
  const appliedProfile = applyCliProfileEnv({ profile: opts.profile });
  const profile = appliedProfile.effectiveProfile;
  if (appliedProfile.warning && !opts.json) {
    runtime.log(theme.warn(appliedProfile.warning));
  }

  const stateDir = resolveProfileStateDir(profile);
  const packageRoot = resolveCliPackageRoot();
  const previousManifest = readManagedWebRuntimeManifest(stateDir);
  const transition = evaluateMajorVersionTransition({
    previousVersion: previousManifest?.deployedDenchVersion,
    currentVersion: VERSION,
  });

  const nonInteractive = Boolean(opts.nonInteractive || opts.json);
  await ensureMajorUpgradeAcknowledged({
    required: transition.isMajorTransition,
    previousVersion: previousManifest?.deployedDenchVersion,
    currentVersion: VERSION,
    nonInteractive,
    yes: Boolean(opts.yes),
    runtime,
  });

  if (transition.isMajorTransition) {
    const openclawCommand = resolveOpenClawCommandOrThrow();
    await runOpenClawUpdateWithProgress(openclawCommand);
  }

  const daemonless = isDaemonlessMode(opts);
  const selectedPort =
    parseOptionalPort(opts.webPort) ??
    parseOptionalPort(previousManifest?.lastPort) ??
    readLastKnownWebPort(stateDir) ??
    DEFAULT_WEB_APP_PORT;
  const gatewayPort = resolveGatewayPort(stateDir);

  if (!daemonless && process.platform === "darwin") {
    uninstallWebRuntimeLaunchAgent();
  }

  const stopResult = await stopManagedWebRuntime({
    stateDir,
    port: selectedPort,
    includeLegacyStandalone: true,
  });

  const gatewayResult: { restarted: boolean; error?: string } = daemonless
    ? { restarted: false, error: "skipped (daemonless)" }
    : await restartGatewayDaemon({ profile, gatewayPort, json: Boolean(opts.json) });

  const workspaceDirs = discoverWorkspaceDirs(stateDir);
  const skillSyncResult = syncManagedSkills({ workspaceDirs, packageRoot });

  const ensureResult = await ensureManagedWebRuntime({
    stateDir,
    packageRoot,
    denchVersion: VERSION,
    port: selectedPort,
    gatewayPort,
    startFn:
      !daemonless && process.platform === "darwin"
        ? (p) => installWebRuntimeLaunchAgent(p)
        : undefined,
  });

  const summary: UpdateWebRuntimeSummary = {
    profile,
    webPort: selectedPort,
    version: VERSION,
    majorGate: {
      required: transition.isMajorTransition,
      previousVersion: previousManifest?.deployedDenchVersion,
      currentVersion: VERSION,
    },
    stoppedPids: stopResult.stoppedPids,
    skippedForeignPids: stopResult.skippedForeignPids,
    ready: ensureResult.ready,
    reason: ensureResult.reason,
    gatewayRestarted: gatewayResult.restarted,
    gatewayError: daemonless ? undefined : gatewayResult.error,
    skillSync: skillSyncResult,
  };

  if (!opts.json) {
    runtime.log("");
    runtime.log(theme.heading("Dench web update"));
    runtime.log(`Profile: ${profile}`);
    runtime.log(`Version: ${VERSION}`);
    runtime.log(`Web port: ${selectedPort}`);
    if (daemonless) {
      runtime.log(`Gateway: skipped (daemonless mode)`);
    } else {
      runtime.log(`Gateway: ${summary.gatewayRestarted ? "restarted" : "restart failed"}`);
    }
    if (summary.gatewayError) {
      runtime.log(theme.warn(`Gateway error: ${summary.gatewayError}`));
    }
    runtime.log(`Stopped web processes: ${summary.stoppedPids.length}`);
    if (summary.skippedForeignPids.length > 0) {
      runtime.log(
        theme.warn(
          `Skipped non-Dench listeners on ${selectedPort}: ${summary.skippedForeignPids.join(", ")}`,
        ),
      );
    }
    runtime.log(`Skills synced: ${summary.skillSync.syncedSkills.join(", ")} (${summary.skillSync.workspaceDirs.length} workspace${summary.skillSync.workspaceDirs.length === 1 ? "" : "s"})`);
    runtime.log(`Web runtime: ${summary.ready ? "ready" : "not ready"}`);
    if (!summary.ready) {
      runtime.log(theme.warn(summary.reason));
    }
  }

  if (!summary.ready) {
    throw new Error(`Web runtime update failed: ${summary.reason}`);
  }

  cleanupManagedWebRuntimeBackup(stateDir);

  await promptAndOpenWebUi({
    webPort: selectedPort,
    json: opts.json,
    noOpen: opts.noOpen,
    runtime,
  });

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
  }
  return summary;
}

export async function stopWebRuntimeCommand(
  opts: StopWebRuntimeOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<StopWebRuntimeSummary> {
  const appliedProfile = applyCliProfileEnv({ profile: opts.profile });
  const profile = appliedProfile.effectiveProfile;
  if (appliedProfile.warning && !opts.json) {
    runtime.log(theme.warn(appliedProfile.warning));
  }

  const stateDir = resolveProfileStateDir(profile);
  const selectedPort = parseOptionalPort(opts.webPort) ?? readLastKnownWebPort(stateDir);

  if (!isDaemonlessMode(opts) && process.platform === "darwin") {
    uninstallWebRuntimeLaunchAgent();
  }

  const stopResult = await stopManagedWebRuntime({
    stateDir,
    port: selectedPort,
    includeLegacyStandalone: true,
  });

  const summary: StopWebRuntimeSummary = {
    profile,
    webPort: selectedPort,
    stoppedPids: stopResult.stoppedPids,
    skippedForeignPids: stopResult.skippedForeignPids,
  };

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  runtime.log("");
  runtime.log(theme.heading("Dench web stop"));
  runtime.log(`Profile: ${profile}`);
  runtime.log(`Web port: ${selectedPort}`);
  runtime.log(
    summary.stoppedPids.length > 0
      ? `Stopped web processes: ${summary.stoppedPids.join(", ")}`
      : "Stopped web processes: none",
  );
  if (summary.skippedForeignPids.length > 0) {
    runtime.log(
      theme.warn(
        `Left non-Dench listener(s) running on ${selectedPort}: ${summary.skippedForeignPids.join(", ")}`,
      ),
    );
  }
  return summary;
}

export type RestartWebRuntimeOptions = StartWebRuntimeOptions;
export type RestartWebRuntimeSummary = StartWebRuntimeSummary;

export async function restartWebRuntimeCommand(
  opts: RestartWebRuntimeOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<RestartWebRuntimeSummary> {
  return startWebRuntimeCommand(opts, runtime, "restart");
}

export async function startWebRuntimeCommand(
  opts: StartWebRuntimeOptions,
  runtime: RuntimeEnv = defaultRuntime,
  label: "start" | "restart" = "start",
): Promise<StartWebRuntimeSummary> {
  const appliedProfile = applyCliProfileEnv({ profile: opts.profile });
  const profile = appliedProfile.effectiveProfile;
  if (appliedProfile.warning && !opts.json) {
    runtime.log(theme.warn(appliedProfile.warning));
  }

  const daemonless = isDaemonlessMode(opts);
  const stateDir = resolveProfileStateDir(profile);
  const selectedPort = parseOptionalPort(opts.webPort) ?? readLastKnownWebPort(stateDir);
  const gatewayPort = resolveGatewayPort(stateDir);

  if (!daemonless && process.platform === "darwin") {
    uninstallWebRuntimeLaunchAgent();
  }

  const stopResult = await stopManagedWebRuntime({
    stateDir,
    port: selectedPort,
    includeLegacyStandalone: true,
  });

  if (stopResult.skippedForeignPids.length > 0) {
    throw new Error(
      `Cannot start on ${selectedPort}; non-Dench listener(s) still own the port: ${stopResult.skippedForeignPids.join(", ")}`,
    );
  }

  const gatewayResult: { restarted: boolean; error?: string } = daemonless
    ? { restarted: false, error: "skipped (daemonless)" }
    : await restartGatewayDaemon({ profile, gatewayPort, json: Boolean(opts.json) });

  let startResult;
  if (!daemonless && process.platform === "darwin") {
    startResult = installWebRuntimeLaunchAgent({ stateDir, port: selectedPort, gatewayPort });
    if (!startResult.started && startResult.reason !== "runtime-missing") {
      startResult = startManagedWebRuntime({ stateDir, port: selectedPort, gatewayPort });
    }
  } else {
    startResult = startManagedWebRuntime({ stateDir, port: selectedPort, gatewayPort });
  }

  if (!startResult.started) {
    const runtimeServerPath = resolveManagedWebRuntimeServerPath(stateDir);
    throw new Error(
      [
        `Managed web runtime is missing at ${runtimeServerPath}.`,
        "Run `npx denchclaw update` (or `npx denchclaw`) to install/update the web runtime first.",
      ].join(" "),
    );
  }

  const probe = await waitForWebRuntime(selectedPort, startResult.pid);

  let probeReason = probe.reason;
  if (!probe.ok) {
    const errLog = readLastLogLines(stateDir, "web-app.err.log", 6);
    if (errLog) {
      probeReason = `${probe.reason}\n--- web-app.err.log ---\n${errLog}`;
    }
  }

  const summary: StartWebRuntimeSummary = {
    profile,
    webPort: selectedPort,
    stoppedPids: stopResult.stoppedPids,
    skippedForeignPids: stopResult.skippedForeignPids,
    started: probe.ok,
    reason: probeReason,
    gatewayRestarted: gatewayResult.restarted,
    gatewayError: daemonless ? undefined : gatewayResult.error,
  };

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  runtime.log("");
  runtime.log(theme.heading(`Dench web ${label}`));
  runtime.log(`Profile: ${profile}`);
  runtime.log(`Web port: ${selectedPort}`);
  if (daemonless) {
    runtime.log(`Gateway: skipped (daemonless mode)`);
  } else {
    runtime.log(`Gateway: ${summary.gatewayRestarted ? "restarted" : "restart failed"}`);
  }
  if (summary.gatewayError) {
    runtime.log(theme.warn(`Gateway error: ${summary.gatewayError}`));
  }
  runtime.log(`Restarted managed web runtime: ${summary.started ? "yes" : "no"}`);
  if (!summary.started) {
    runtime.log(theme.warn(summary.reason));
  }

  if (!summary.started) {
    throw new Error(`Web runtime failed readiness probe: ${summary.reason}`);
  }

  cleanupManagedWebRuntimeBackup(stateDir);

  await promptAndOpenWebUi({
    webPort: selectedPort,
    json: opts.json,
    noOpen: opts.noOpen,
    runtime,
  });

  return summary;
}

export async function verifyOpenClawHealthForUpdate(profile: string): Promise<void> {
  const openclawCommand = resolveOpenClawCommandOrThrow();
  const result = await runOpenClawCommand({
    openclawCommand,
    args: ["--profile", profile, "health", "--json"],
    timeoutMs: 12_000,
  });
  if (result.code === 0) {
    return;
  }
  const detail = firstNonEmptyLine(result.stderr, result.stdout);
  throw new Error(
    detail ? `Gateway health check failed.\n${detail}` : "Gateway health check failed.",
  );
}
