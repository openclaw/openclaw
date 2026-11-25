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

const spawnSyncDefaults = {
  pid: 0,
  output: [null, "", ""],
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
} satisfies SpawnSyncReturns<string>;
export type SpawnSyncResult = typeof spawnSyncDefaults;

export function makeSpawnSyncResult(overrides: Partial<SpawnSyncResult> = {}): SpawnSyncResult {
  return { ...spawnSyncDefaults, output: [...spawnSyncDefaults.output], ...overrides };
}

export function createSpawnChild(unref: () => void, error?: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = unref;
  queueMicrotask(() => child.emit(error ? "error" : "spawn", error));
  return child;
}
