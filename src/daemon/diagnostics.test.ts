import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLogTailLines, readLastGatewayErrorLine } from "./diagnostics.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const DIAGNOSTIC_TAIL_BYTES = 256 * 1024;
type PositionalRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

afterEach(() => vi.restoreAllMocks());

function logs(stdout: string, stderr?: string, platform: "linux" | "darwin" = "linux") {
  const env = {
    HOME: dirs.make("diagnostic-home-"),
    OPENCLAW_STATE_DIR: dirs.make("diagnostic-state-"),
  };
  const paths = (platform === "darwin" ? resolveGatewaySupervisorLogPaths : resolveGatewayLogPaths)(
    env,
  );
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.writeFileSync(paths.stdoutPath, stdout, "utf8");
  if (stderr !== undefined) {
    fs.writeFileSync(paths.stderrPath, stderr, "utf8");
  }
  return env;
}

it("reads the launchd supervisor log instead of a state-dir stderr file on darwin", async () => {
  const env = logs("Gateway failed to start: current failure\n", undefined, "darwin");
  const stateLogs = resolveGatewayLogPaths(env);
  fs.mkdirSync(stateLogs.logDir, { recursive: true });
  fs.writeFileSync(stateLogs.stderrPath, "failed to bind gateway socket stale\n", "utf8");

  await expect(readLastGatewayErrorLine(env, { platform: "darwin" })).resolves.toBe(
    "Gateway failed to start: current failure",
  );
});

it("prefers the current stderr error over a stale stdout match on linux", async () => {
  const env = logs(
    "gateway start blocked: stale prior reason\n",
    "failed to bind gateway socket EADDRINUSE\n",
  );

  await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
    "failed to bind gateway socket EADDRINUSE",
  );
});

it("ignores stale stdout errors outside the bounded diagnostic tail", async () => {
  const env = logs(
    `gateway start blocked: stale prior reason\n${"non-error filler line\n".repeat(20_000)}\ngateway stdout current\n`,
  );

  await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBeNull();
});

it("ignores a matching partial line at the bounded tail boundary", async () => {
  const env = logs(
    `${"x".repeat(DIAGNOSTIC_TAIL_BYTES + 1)} gateway start blocked: partial stale reason\n` +
      "gateway stdout current\n",
  );

  await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBeNull();
});

it("fills short positional reads before decoding the tail", async () => {
  const file = path.join(dirs.make("diagnostic-tail-"), "gateway.log");
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
  const env = logs(
    "parse/handle error: Error: ENOSPC: no space left on device, write\n",
    "gateway stderr tail without a known pattern\n",
  );

  await expect(readLastGatewayErrorLine(env, { platform: "linux" })).resolves.toBe(
    "parse/handle error: Error: ENOSPC: no space left on device, write",
  );
});
