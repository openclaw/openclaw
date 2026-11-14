import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLogTailLines } from "./diagnostics.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const overTail = "x".repeat(256 * 1024 + 1);
const blocked = "gateway start blocked";
const bindError = "failed to bind gateway socket";
const startupFailure = "Gateway failed to start: current failure";
const FIFO = Symbol("writerless FIFO");
type PositionalRead = (
  ...args: [buffer: Buffer, offset: number, length: number, position: number]
) => Promise<{ bytesRead: number; buffer: Buffer }>;
afterEach(() => vi.restoreAllMocks());

for (const [name, platform, stdout, stderr, expected] of [
  ["stderr wins", "linux", blocked, bindError, bindError],
  ["outside tail", "linux", `${blocked}\n${"filler\n".repeat(50_000)}current\n`, undefined, null],
  ["partial boundary", "linux", `${overTail} ${blocked}\ncurrent\n`, undefined, null],
  ["ENOSPC over generic stderr", "linux", "ENOSPC", "generic stderr", "ENOSPC"],
  ["launchd supervisor log", "darwin", startupFailure, undefined, startupFailure],
  [
    "ownership refusal",
    "darwin",
    "cannot verify Gateway ownership; holder 4242 at synthetic-private-host",
    undefined,
    expect.stringMatching(/Gateway ownership could not be verified.*openclaw gateway recover-lock/),
  ],
  ["stdout FIFO", "linux", FIFO, bindError, bindError],
  ["stderr FIFO", "linux", blocked, FIFO, blocked],
] as const) {
  it.skipIf(process.platform === "win32" && (stdout === FIFO || stderr === FIFO))(name, () => {
    const root = dirs.make("diagnostic-log-");
    const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const paths = (
      platform === "darwin" ? resolveGatewaySupervisorLogPaths : resolveGatewayLogPaths
    )(env);
    fs.mkdirSync(paths.logDir, { recursive: true });
    for (const key of ["stdoutPath", "stderrPath"] as const) {
      const value = key === "stdoutPath" ? stdout : stderr;
      if (value === FIFO) {
        execFileSync("mkfifo", [paths[key]]);
      } else if (value !== undefined) {
        fs.writeFileSync(paths[key], value);
      }
    }
    if (platform === "darwin") {
      const stateLogs = resolveGatewayLogPaths(env);
      fs.mkdirSync(stateLogs.logDir, { recursive: true });
      fs.writeFileSync(stateLogs.stderrPath, `${bindError} stale\n`);
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
        console.log(JSON.stringify(await readLastGatewayErrorLine(${JSON.stringify(env)}, { platform: ${JSON.stringify(platform)} })));
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

it("fills short positional reads before decoding the tail", async () => {
  const file = path.join(dirs.make("diagnostic-tail-"), "gateway.log");
  const lines = ["old line", "recent one", "recent two"];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  const realOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const realRead = handle.read.bind(handle) as PositionalRead;
    const shortRead = vi.fn<PositionalRead>((buffer, offset, length, position) =>
      realRead(buffer, offset, Math.min(length, 3), position),
    );
    Object.defineProperty(handle, "read", { configurable: true, value: shortRead });
    return handle;
  });
  await expect(readGatewayLogTailLines(file)).resolves.toEqual(lines);
});
