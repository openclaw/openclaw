import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { PortUsage } from "../../infra/ports-types.js";
import type { killProcessTree as killProcessTreeImpl } from "../../process/kill-tree.js";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";
import { resolveTaskScriptPath } from "../schtasks-layout.js";

export const schtasksResponses: Array<{ code: number; stdout: string; stderr: string }> = [];
export const schtasksCalls: string[][] = [];
// Opt-in native registration state: repeated XML reads do not consume mutation results.
export const schtasksRegistration: {
  response?: (typeof schtasksResponses)[number];
  onCommand?: (argv: string[], response: (typeof schtasksResponses)[number]) => void;
} = {};

export const inspectPortUsageMock: MockFn<
  (port: number, options?: { probeHosts?: readonly string[] }) => Promise<PortUsage>
> = vi.fn();
export const gatewayServiceProbeHostsMock: MockFn<() => Promise<readonly string[]>> = vi.fn();
export const killProcessTreeMock: MockFn<typeof killProcessTreeImpl> = vi.fn();

export async function withWindowsEnv(
  prefix: string,
  run: (params: { tmpDir: string; env: Record<string, string> }) => Promise<void>,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = {
    USERPROFILE: tmpDir,
    APPDATA: path.join(tmpDir, "AppData", "Roaming"),
    OPENCLAW_PROFILE: "default",
    OPENCLAW_GATEWAY_PORT: "18789",
  };
  try {
    await run({ tmpDir, env });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function resetSchtasksBaseMocks() {
  schtasksResponses.length = 0;
  schtasksCalls.length = 0;
  delete schtasksRegistration.response;
  delete schtasksRegistration.onCommand;
  inspectPortUsageMock.mockReset();
  gatewayServiceProbeHostsMock.mockReset().mockResolvedValue(["127.0.0.1"]);
  killProcessTreeMock.mockReset();
}

async function writeScript(scriptPath: string, lines: string[]) {
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, ["@echo off", ...lines, ""].join("\r\n"), "utf8");
}

export async function writeGatewayScript(
  env: Record<string, string>,
  port = Number(env.OPENCLAW_GATEWAY_PORT || "18789"),
) {
  return writeScript(resolveTaskScriptPath(env), [
    `set "OPENCLAW_GATEWAY_PORT=${port}"`,
    `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port ${port}`,
  ]);
}

export function resolveStartupFixturePath(env: Record<string, string>, extension = "cmd") {
  const taskName = env.OPENCLAW_WINDOWS_TASK_NAME ?? "OpenClaw Gateway";
  return path.join(
    expectDefined(env.APPDATA, "env.APPDATA test invariant"),
    "Microsoft/Windows/Start Menu/Programs/Startup",
    `${taskName}.${extension}`,
  );
}

export async function writeStartupFallbackEntry(env: Record<string, string>, extension = "cmd") {
  const startupEntryPath = resolveStartupFixturePath(env, extension);
  await writeScript(startupEntryPath, []);
  return startupEntryPath;
}

export async function writeNodeScript(env: Record<string, string>, port = "18789") {
  return writeScript(resolveTaskScriptPath(env), [
    `set "OPENCLAW_SERVICE_KIND=node"`,
    `set "OPENCLAW_GATEWAY_PORT=${port}"`,
    `"C:\\bin\\openclaw.cmd" node run --host 127.0.0.1 --port ${port}`,
  ]);
}

const spawnSyncDefaults = {
  pid: 0,
  output: [null, "", ""],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
} satisfies SpawnSyncReturns<string>;
export type SpawnSyncResult = typeof spawnSyncDefaults;

export function isProcessSnapshotQuery(args: readonly string[] | undefined): boolean {
  const markers = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,CommandLine",
    "ConvertTo-Json",
  ];
  return args?.some((arg) => markers.every((marker) => arg.includes(marker))) ?? false;
}

export function makeSpawnSyncResult(overrides: Partial<SpawnSyncResult> = {}): SpawnSyncResult {
  return { ...spawnSyncDefaults, output: [...spawnSyncDefaults.output], ...overrides };
}

export function createSpawnChild(unref: () => void, error?: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = unref;
  queueMicrotask(() => child.emit(error ? "error" : "spawn", error));
  return child;
}

export type TaskProbeResult = { status: number; stdout: string; stderr?: string };
export type TaskSnapshot = { state: number; lastRunTime: string; lastRunResult: number };
export type NativeResponse = (typeof schtasksResponses)[number] | TaskSnapshot;

export function notYetRunTaskSnapshot(lastRunTime = "1999-11-30T00:00:00.0000000Z"): TaskSnapshot {
  return { state: 3, lastRunTime, lastRunResult: 267011 };
}

export function cleanExitTaskSnapshot(lastRunTime = "2026-05-02T14:41:39.0000000Z"): TaskSnapshot {
  return { state: 3, lastRunTime, lastRunResult: 0 };
}

export function runningTaskSnapshot(): TaskSnapshot {
  return { state: 4, lastRunTime: "2026-04-15T23:42:31.0000000Z", lastRunResult: 267009 };
}

/** Native registration/process facts remain stable across repeated inspection reads. */
export function createSchtasksNativeFixture(getEnv: () => Record<string, string>) {
  const launcherPath = "C:\\fixture\\gateway.cmd";
  const queuedProbes: string[] = [];
  let currentProbe = JSON.stringify(notYetRunTaskSnapshot());
  const advance = () => {
    if (schtasksCalls.some(([action]) => action === "/Run")) {
      currentProbe = queuedProbes.shift() ?? currentProbe;
    }
  };
  return {
    advance,
    queue: (...responses: NativeResponse[]) => {
      for (const response of responses) {
        if ("state" in response) {
          const probe = JSON.stringify(response);
          if (schtasksResponses.length === 0) {
            currentProbe = probe;
          } else {
            queuedProbes.push(probe);
          }
        } else {
          schtasksResponses.push(response);
        }
      }
    },
    probe: (): TaskProbeResult => {
      if (schtasksRegistration.response?.code !== 0) {
        return { status: 1, stdout: "-2147024894" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          ...JSON.parse(currentProbe),
          enabled: !schtasksRegistration.response.stdout.includes("<Enabled>false</Enabled>"),
          taskPath: getEnv().OPENCLAW_WINDOWS_TASK_NAME ?? "OpenClaw Gateway",
          actions: [{ type: 0, path: launcherPath, arguments: "", workingDirectory: "" }],
        }),
      };
    },
    reset: () => {
      schtasksRegistration.response = {
        code: 0,
        stdout: `<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>${launcherPath}</Command></Exec></Actions></Task>`,
        stderr: "",
      };
      currentProbe = JSON.stringify(notYetRunTaskSnapshot());
      queuedProbes.length = 0;
      schtasksRegistration.onCommand = (argv, response) => {
        if (response.code === 0 && argv[0] === "/Run") {
          advance();
        }
        if (response.code === 0 && argv[0] === "/End") {
          currentProbe = JSON.stringify(cleanExitTaskSnapshot());
        }
      };
      // Keep native absolute-path admission while storing launcher bytes in the host temp directory.
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation((pathname, options) =>
        readFile(pathname === launcherPath ? resolveTaskScriptPath(getEnv()) : pathname, options),
      );
    },
  };
}
