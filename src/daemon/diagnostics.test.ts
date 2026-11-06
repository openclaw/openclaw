import { execFileSync, spawnSync } from "node:child_process";
// Daemon diagnostics tests cover service diagnostic collection and formatting.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGatewayLogTailLines, readLastGatewayErrorLine } from "./diagnostics.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

const tempDirs: string[] = [];
const DIAGNOSTIC_TAIL_BYTES = 256 * 1024;
type PositionalRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-daemon-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}

describe("readLastGatewayErrorLine", () => {
  it("reads the launchd supervisor log instead of a state-dir stderr file on darwin", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    const launchdLogs = resolveGatewaySupervisorLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.mkdirSync(launchdLogs.logDir, { recursive: true });
    fs.writeFileSync(stateLogs.stderrPath, "failed to bind gateway socket stale\n", "utf8");
    fs.writeFileSync(launchdLogs.stdoutPath, "Gateway failed to start: current failure\n", "utf8");

    await expect(readLastGatewayErrorLine(env, { platform: "darwin" })).resolves.toBe(
      "Gateway failed to start: current failure",
    );
  });

  it("prefers the current stderr error over a stale stdout match on linux", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    // stderr carries the real, current failure; stdout carries an older matching
    // line. On non-darwin platforms stderr is the strongest failure signal, so
    // it must win instead of the stale stdout match.
    fs.writeFileSync(stateLogs.stderrPath, "failed to bind gateway socket EADDRINUSE\n", "utf8");
    fs.writeFileSync(stateLogs.stdoutPath, "gateway start blocked: stale prior reason\n", "utf8");

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
      "failed to bind gateway socket EADDRINUSE",
    );
  });

  it("ignores stale stdout errors outside the bounded diagnostic tail", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.writeFileSync(
      stateLogs.stdoutPath,
      [
        "gateway start blocked: stale prior reason",
        "non-error filler line\n".repeat(20_000),
        "gateway stdout current",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBeNull();
  });

  it("ignores a matching partial line at the bounded tail boundary", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.writeFileSync(
      stateLogs.stdoutPath,
      `${"x".repeat(DIAGNOSTIC_TAIL_BYTES + 1)} gateway start blocked: partial stale reason\n` +
        "gateway stdout current\n",
      "utf8",
    );

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBeNull();
  });

  it("fills short positional reads before decoding the tail", async () => {
    const dir = makeTempStateDir();
    const file = path.join(dir, "gateway.log");
    fs.writeFileSync(file, "old line\nrecent one\nrecent two\n", "utf8");
    const realOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle) as PositionalRead;
      const shortRead = vi.fn<PositionalRead>((buffer, offset, length, position) =>
        realRead(buffer, offset, Math.min(length, 3), position),
      );
      Object.defineProperty(handle, "read", { configurable: true, value: shortRead });
      return handle;
    });

    await expect(readGatewayLogTailLines(file)).resolves.toEqual([
      "old line",
      "recent one",
      "recent two",
    ]);
  });

  it("surfaces ENOSPC from stdout ahead of a generic stderr tail on linux", async () => {
    const stateDir = makeTempStateDir();
    const homeDir = makeTempStateDir();
    const env = { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir };
    const stateLogs = resolveGatewayLogPaths(env);
    fs.mkdirSync(stateLogs.logDir, { recursive: true });
    fs.writeFileSync(
      stateLogs.stdoutPath,
      "parse/handle error: Error: ENOSPC: no space left on device, write\n",
      "utf8",
    );
    fs.writeFileSync(stateLogs.stderrPath, "gateway stderr tail without a known pattern\n", "utf8");

    await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
      "parse/handle error: Error: ENOSPC: no space left on device, write",
    );
  });
});

const FIFO = Symbol("writerless FIFO");
const blocked = "gateway start blocked";
const bindError = "failed to bind gateway socket";
for (const [name, stdout, stderr, expected] of [
  ["stdout FIFO", FIFO, bindError, bindError],
  ["stderr FIFO", blocked, FIFO, blocked],
] as const) {
  it.skipIf(process.platform === "win32" && (stdout === FIFO || stderr === FIFO))(name, () => {
    const root = makeTempStateDir();
    const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const paths = resolveGatewayLogPaths(env);
    fs.mkdirSync(paths.logDir, { recursive: true });
    for (const key of ["stdoutPath", "stderrPath"] as const) {
      const value = key === "stdoutPath" ? stdout : stderr;
      if (value === FIFO) {
        execFileSync("mkfifo", [paths[key]]);
      } else if (value !== undefined) {
        fs.writeFileSync(paths[key], value);
      }
    }
    // Bound native FIFO opens outside the test worker, including on a regressed reader.
    const probe = spawnSync(
      process.execPath,
      [
        `--import=${new URL("../../scripts/tsx.mjs", import.meta.url).href}`,
        "--input-type=module",
        "-e",
        `
        import { readLastGatewayErrorLine } from ${JSON.stringify(new URL("./diagnostics.ts", import.meta.url).href)};
        console.log(JSON.stringify(await readLastGatewayErrorLine(${JSON.stringify(env)}, { platform: "linux" })));
      `,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect([probe.error, probe.status]).toEqual([undefined, 0]);
    expect(JSON.parse(probe.stdout)).toEqual(expected);
    expect(probe.stdout).not.toContain("synthetic-private-host");
    for (const key of ["stdoutPath", "stderrPath"] as const) {
      if ((key === "stdoutPath" ? stdout : stderr) === FIFO) {
        expect(fs.lstatSync(paths[key]).isFIFO()).toBe(true);
      }
    }
  });
}
