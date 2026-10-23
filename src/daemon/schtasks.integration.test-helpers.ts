import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
} from "../infra/windows-install-roots.js";
import { resolveTaskScriptPath } from "./schtasks-layout.js";
import { launchFallbackTaskScript } from "./schtasks-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";

const POLL_INTERVAL_MS = 200;
const RUN_EVENT_SETTLE_MS = 2_000;
const WAIT_TIMEOUT_MS = 30_000;

function nativeCommand(
  executable: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    ...options,
  });
}

export type ProbeRunEvent = {
  phase: "listening" | "started";
  pid: number;
  ppid: number;
};

async function expectNativeLaunchFailure(
  operation: () => Promise<void>,
  expectedCodes: readonly string[],
): Promise<string> {
  try {
    await operation();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && expectedCodes.includes(code)) {
      return code;
    }
    throw new Error(`Startup fallback rejected with unexpected error ${code ?? "unknown"}`, {
      cause: error,
    });
  }
  throw new Error("Startup fallback reported success for an unlaunchable command");
}

async function waitForNativeLaunchMarker(markerPath: string, launcherPid: number): Promise<number> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const marker = await fs.readFile(markerPath, "utf8").catch(() => "");
    if (marker) {
      const [childIdentity, parentIdentity] = marker.trim().split(":");
      const pid = Number(childIdentity);
      if (!Number.isSafeInteger(pid) || pid <= 1 || Number(parentIdentity) !== launcherPid) {
        throw new Error("Startup fallback probe recorded an invalid process identity");
      }
      return pid;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Startup fallback detached process did not write its launch marker");
}

async function runShortLivedStartupLauncher(proofRoot: string, mode: "batch" | "direct") {
  const markerPath = path.join(proofRoot, `${mode}.pid`);
  const parentPidPath = path.join(proofRoot, `${mode}-parent.pid`);
  const result = nativeCommand(
    process.execPath,
    [
      path.join(proofRoot, "launcher.mts"),
      mode,
      markerPath,
      parentPidPath,
      path.join(proofRoot, "probe.cjs"),
    ],
    { cwd: process.cwd(), timeout: WAIT_TIMEOUT_MS },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Startup fallback ${mode} launcher parent did not exit successfully`, {
      cause: result.error,
    });
  }
  const launcherPid = Number((await fs.readFile(parentPidPath, "utf8")).trim());
  if (!Number.isSafeInteger(launcherPid) || launcherPid <= 1) {
    throw new Error("Startup fallback recorded an invalid launcher parent identity");
  }
  return {
    launcherPid,
    childPid: await waitForNativeLaunchMarker(markerPath, launcherPid),
  };
}

function resolveCurrentWindowsUserSid(): string {
  const result = nativeCommand(getWindowsPowerShellExePath(), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ]);
  const sid = result.stdout?.trim();
  if (result.error || result.status !== 0 || !sid || !/^S-1-[0-9-]+$/u.test(sid)) {
    throw new Error("Could not resolve the current Windows user SID for isolated ACL proof");
  }
  return sid;
}

function updateNativeScriptAcl(scriptPath: string, args: string[]): void {
  const result = nativeCommand(getWindowsSystem32ExePath("icacls.exe"), [scriptPath, ...args]);
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not update isolated Startup script ACL (exit ${result.status ?? "unknown"})`,
      {
        cause: result.error,
      },
    );
  }
}

export async function proveNativeStartupFallbackLaunch(params: {
  env: GatewayServiceEnv;
  rootDir: string;
  runtimeModuleUrl: URL;
}) {
  const proofRoot = path.join(params.rootDir, "startup-fallback-proof");
  const stateDir = path.join(proofRoot, "state & %OPENCLAW_STARTUP_PROBE% !");
  const env: GatewayServiceEnv = {
    ...params.env,
    APPDATA: path.join(proofRoot, "appdata"),
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
  };
  const scriptPath = resolveTaskScriptPath(env);
  const probePath = path.join(proofRoot, "probe.cjs");
  const harnessPath = path.join(proofRoot, "launcher.mts");
  const directMarkerPath = path.join(proofRoot, "direct.pid");
  const batchMarkerPath = path.join(proofRoot, "batch.pid");
  const batchParentPidPath = path.join(proofRoot, "batch-parent.pid");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    probePath,
    [
      'const fs = require("node:fs");',
      'const launcherPid = Number(fs.readFileSync(process.argv[3], "utf8"));',
      "const deadline = Date.now() + 10_000;",
      "function waitForLauncherExit() {",
      "  try { process.kill(launcherPid, 0); } catch (error) {",
      '    if (error.code !== "ESRCH") throw error;',
      "    fs.writeFileSync(process.argv[2], `${process.pid}:${launcherPid}`);",
      "    return;",
      "  }",
      "  if (Date.now() >= deadline) process.exit(2);",
      "  setTimeout(waitForLauncherExit, 25);",
      "}",
      "waitForLauncherExit();",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    harnessPath,
    [
      'import fs from "node:fs";',
      `import { launchFallbackTaskScript } from ${JSON.stringify(params.runtimeModuleUrl.href)};`,
      `const env = ${JSON.stringify({
        APPDATA: env.APPDATA,
        OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
        OPENCLAW_PROFILE: env.OPENCLAW_PROFILE,
        OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
      })};`,
      "const [mode, markerPath, parentPidPath, probePath] = process.argv.slice(2);",
      "fs.writeFileSync(parentPidPath, String(process.pid));",
      "const command = mode === 'direct' ? {",
      "  programArguments: [process.execPath, probePath, markerPath, parentPidPath],",
      `  workingDirectory: ${JSON.stringify(proofRoot)},`,
      "} : null;",
      "await launchFallbackTaskScript(env, command);",
      "",
    ].join("\n"),
  );

  const missingScriptError = await expectNativeLaunchFailure(
    () => launchFallbackTaskScript(env, null),
    ["ENOENT"],
  );
  await fs.writeFile(
    scriptPath,
    `@echo off\r\n"${process.execPath}" "${probePath}" "${batchMarkerPath}" "${batchParentPidPath}"\r\n`,
    "utf8",
  );
  const missingExecutableError = await expectNativeLaunchFailure(
    () =>
      launchFallbackTaskScript(env, {
        programArguments: [path.join(proofRoot, "missing-node.exe"), probePath, directMarkerPath],
        workingDirectory: proofRoot,
      }),
    ["ENOENT"],
  );
  const directLaunch = await runShortLivedStartupLauncher(proofRoot, "direct");
  const batchLaunch = await runShortLivedStartupLauncher(proofRoot, "batch");

  const userSid = `*${resolveCurrentWindowsUserSid()}`;
  updateNativeScriptAcl(scriptPath, ["/deny", `${userSid}:(RD)`]);
  let deniedReadError: string;
  try {
    // Node's existence and privileged backup opens bypass the DACL; cmd must still reject it.
    await fs.access(scriptPath);
    deniedReadError = await expectNativeLaunchFailure(
      () => launchFallbackTaskScript(env, null),
      ["EACCES", "EPERM"],
    );
  } finally {
    updateNativeScriptAcl(scriptPath, ["/remove:d", userSid]);
  }
  await (await fs.open(scriptPath, "r")).close();

  return {
    directLaunchPid: directLaunch.childPid,
    directLauncherPid: directLaunch.launcherPid,
    batchLaunchPid: batchLaunch.childPid,
    batchLauncherPid: batchLaunch.launcherPid,
    missingExecutableError,
    missingScriptError,
    deniedReadError,
  };
}

async function readRunEvents(eventsPath: string): Promise<ProbeRunEvent[]> {
  const content = await fs.readFile(eventsPath, "utf8").catch(() => "");
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Partial<ProbeRunEvent>;
      if (
        (parsed.phase !== "started" && parsed.phase !== "listening") ||
        !Number.isSafeInteger(parsed.pid) ||
        (parsed.pid ?? 0) <= 1 ||
        !Number.isSafeInteger(parsed.ppid) ||
        (parsed.ppid ?? 0) <= 1
      ) {
        throw new Error("Scheduled Task probe recorded an invalid run event");
      }
      return parsed as ProbeRunEvent;
    });
}

export async function waitForExactProbeRun(
  eventsPath: string,
  expectedCount: number,
): Promise<ProbeRunEvent> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let events: ProbeRunEvent[] = [];
  while (Date.now() < deadline) {
    events = await readRunEvents(eventsPath);
    if (events.filter((event) => event.phase === "listening").length >= expectedCount) {
      await sleep(RUN_EVENT_SETTLE_MS);
      events = await readRunEvents(eventsPath);
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const started = events.filter((event) => event.phase === "started");
  const listening = events.filter((event) => event.phase === "listening");
  if (started.length !== expectedCount || listening.length !== expectedCount) {
    throw new Error(
      `Expected exactly ${expectedCount} Scheduled Task probe runs; observed ${started.length} starts and ${listening.length} listeners`,
    );
  }
  const startedEvent = started[expectedCount - 1];
  const listeningEvent = listening[expectedCount - 1];
  if (!startedEvent || !listeningEvent) {
    throw new Error(`Scheduled Task run ${expectedCount} did not record complete process events`);
  }
  if (startedEvent.pid !== listeningEvent.pid || startedEvent.ppid !== listeningEvent.ppid) {
    throw new Error(
      `Scheduled Task run ${expectedCount} changed process identity before listening`,
    );
  }
  return startedEvent;
}
