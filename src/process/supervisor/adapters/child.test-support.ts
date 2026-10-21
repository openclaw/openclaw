import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { vi, type Mock } from "vitest";

export function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

export function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  const define = (key: keyof ChildProcess, value: unknown, writable = true) =>
    Object.defineProperty(child, key, { value, writable, configurable: true });
  define("stdio", [child.stdin, child.stdout, child.stderr], false);
  define("pid", pid, false);
  define("killed", false);
  define("exitCode", null);
  define("signalCode", null);
  define("channel", {}, false);
  define("connected", true);
  const killMock = vi.fn(() => true);
  const sendMock = vi.fn((_message: unknown, ...args: unknown[]) => {
    const callback = args.findLast((value) => typeof value === "function") as
      | ((error: Error | null) => void)
      | undefined;
    callback?.(null);
    return true;
  });
  const disconnectMock = vi.fn(() => {
    define("connected", false);
    child.emit("disconnect");
  });
  child.kill = killMock as ChildProcess["kill"];
  child.send = sendMock as ChildProcess["send"];
  child.disconnect = disconnectMock as ChildProcess["disconnect"];
  const emitClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.emit("close", code, signal);
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    define("exitCode", code);
    define("signalCode", signal);
    child.emit("exit", code, signal);
  };
  return { child, disconnectMock, killMock, sendMock, emitClose, emitExit };
}

type SpawnAndWaitParams = Parameters<typeof import("../../spawn-utils.js").spawnAndWait>[0];

export function firstSpawnAndWaitParams(mock: Mock): SpawnAndWaitParams {
  const params = firstMockArg(mock, "spawnAndWait");
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected spawnAndWait params to be an object");
  }
  return params;
}

export function firstMockArg<T>(mock: { mock: { calls: readonly T[][] } }, label: string) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

export async function createWindowsNpmShim(params: {
  binDir: string;
  command: string;
  packagePath: string[];
}) {
  const { binDir } = params;
  const entrypoint = path.join(binDir, "node_modules", ...params.packagePath);
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, "", "utf8");
  const relativeEntrypoint = path.relative(binDir, entrypoint).replaceAll(path.sep, "\\");
  const shimHead =
    "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
  const shimCommand = `IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${relativeEntrypoint}" %*\r\n`;
  await writeFile(path.join(binDir, `${params.command}.cmd`), `${shimHead}${shimCommand}`, "utf8");
  return { binDir, entrypoint };
}
type ChildAdapterFactory = typeof import("./child.js").createChildAdapter;

export function readyChildAdapter(create: ChildAdapterFactory) {
  return async (params: Parameters<ChildAdapterFactory>[0]) => {
    const { adapter, ready } = await create(params);
    await ready;
    return adapter;
  };
}
