import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { shortenHomePath } from "../utils.js";
import { createBackupArchive } from "./backup-create.js";
import { buildEncodedPowerShellArgs } from "./windows-powershell-spawn.js";

type NativeRead = {
  kind: "denied" | "read";
  code?: string;
  errno?: number;
  syscall?: string;
  bytes?: number;
};
type LockMode = "transient" | "persistent";

async function withLockedHeader<T>(
  directory: string,
  pathname: string,
  mode: LockMode,
  signal: AbortSignal,
  capture: () => Promise<T>,
): Promise<{ value: T; reads: NativeRead[] }> {
  const release = path.join(directory, "release-lock");
  const released = path.join(directory, "lock-released");
  const trace = path.join(directory, "native-reads.jsonl");
  const observer = path.join(directory, "observe-native-read.cjs");
  // Observe genuine OS errors, without injecting errno or changing read results.
  // Only transient scheduling is controlled: unlock after the first denied read,
  // before rethrowing that same native exception into the production retry owner.
  await fs.writeFile(
    observer,
    `const fs = require("node:fs");
const path = require("node:path");
const open = fs.openSync, close = fs.closeSync, read = fs.readSync;
const fds = new Set();
const target = ${JSON.stringify(pathname)}.toLowerCase();
const record = event => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(event) + "\\n");
fs.openSync = function(file, ...args) {
  const fd = open.call(this, file, ...args);
  if (path.resolve(String(file)).toLowerCase() === target) fds.add(fd);
  return fd;
};
fs.closeSync = function(fd) { fds.delete(fd); return close.call(this, fd); };
fs.readSync = function(fd, ...args) {
  if (!fds.has(fd)) return read.call(this, fd, ...args);
  let bytes;
  try { bytes = read.call(this, fd, ...args); }
  catch (error) {
    record({ kind: "denied", code: error.code, errno: error.errno, syscall: error.syscall });
    if (${JSON.stringify(mode)} === "transient") {
      fs.writeFileSync(${JSON.stringify(release)}, "release");
      const deadline = Date.now() + 5000;
      const gate = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(${JSON.stringify(released)})) {
        if (Date.now() >= deadline) throw new Error("Native lock holder did not acknowledge release");
        Atomics.wait(gate, 0, 0, 5);
      }
    }
    throw error;
  }
  record({ kind: "read", bytes });
  return bytes;
};
`,
  );
  const ready = createDeferredCore();
  const controller = new AbortController();
  let output = "";
  const holder = runUtf8CommandWithTimeout(
    [
      "powershell.exe",
      ...buildEncodedPowerShellArgs(`
$ErrorActionPreference = "Stop"
$stream = [IO.FileStream]::new($env:OPENCLAW_TEST_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
try {
  $stream.Lock(0, 16)
  [Console]::Out.WriteLine("header-lock-ready")
  [Console]::Out.Flush()
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not [IO.File]::Exists($env:OPENCLAW_TEST_LOCK_RELEASE)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw "Native lock release deadline expired" }
    [Threading.Thread]::Sleep(5)
  }
  $stream.Unlock(0, 16)
  [IO.File]::WriteAllText($env:OPENCLAW_TEST_LOCK_RELEASED, "released")
} finally { $stream.Dispose() }
`),
    ],
    {
      timeoutMs: 90_000,
      killProcessTree: true,
      signal: AbortSignal.any([signal, controller.signal]),
      env: {
        ...process.env,
        OPENCLAW_TEST_LOCK_PATH: pathname,
        OPENCLAW_TEST_LOCK_RELEASE: release,
        OPENCLAW_TEST_LOCK_RELEASED: released,
      },
      onOutputChunk: (chunk, stream) => {
        if (stream === "stdout") {
          output += chunk.toString("utf8");
          if (output.includes("header-lock-ready")) {
            ready.resolve();
          }
        }
      },
    },
  );
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        ready.promise,
        holder,
        "Native lock holder exited before readiness",
      ),
      signal,
    );
    vi.stubEnv(
      "NODE_OPTIONS",
      `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(observer)}`,
    );
    const value = await capture();
    vi.unstubAllEnvs();
    await fs.writeFile(release, "release");
    const result = await withinTest(holder, signal);
    expect(result.code, result.stderr).toBe(0);
    const reads: NativeRead[] = (await fs.readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { value, reads };
  } finally {
    vi.unstubAllEnvs();
    controller.abort();
    await holder.catch(() => undefined);
  }
}

async function exerciseNativeLock(mode: LockMode, signal: AbortSignal) {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const candidate = state.statePath("retained-native-candidate.db");
    const bytes = Buffer.from("retained native Windows backup source bytes");
    const config = await fs.readFile(state.configPath);
    await fs.writeFile(candidate, bytes);
    const output = state.path("backups");
    await fs.mkdir(output);
    const { value, reads } = await withLockedHeader(
      state.root,
      candidate,
      mode,
      signal,
      async () => {
        try {
          return await createBackupArchive({ output, includeWorkspace: false });
        } catch (error) {
          if (error instanceof Error) {
            return error;
          }
          throw error;
        }
      },
    );
    const denied = reads.filter((read) => read.kind === "denied");
    expect(denied[0]).toMatchObject({
      code: expect.stringMatching(/^(EBUSY|EPERM|EACCES)$/),
      errno: expect.any(Number),
      syscall: "read",
    });
    expect(await fs.readFile(candidate)).toEqual(bytes);
    expect(await fs.readFile(state.configPath)).toEqual(config);
    if (mode === "persistent") {
      expect(denied).toHaveLength(3);
      if (!(value instanceof Error)) {
        throw new Error("Backup accepted a persistently locked source");
      }
      expect(value.message).toContain("Could not determine whether backup files are SQLite");
      expect(value.message).toContain(shortenHomePath(candidate));
      expect(value.message).toContain(denied[0]!.code);
      expect(value.cause).toMatchObject({
        path: candidate,
        code: denied[0]!.code,
        errno: denied[0]!.errno,
      });
      expect(await fs.readdir(output)).toEqual([]);
      const control = await createBackupArchive({ output, includeWorkspace: false });
      await verifyBackupArchive(control.archivePath);
    } else {
      expect(denied).toHaveLength(1);
      expect(reads).toContainEqual({ kind: "read", bytes: 16 });
      if (value instanceof Error) {
        throw value;
      }
      await verifyBackupArchive(value.archivePath);
    }
    console.log(
      "[native-backup-sharing-proof]",
      JSON.stringify({ mode, reads, platform: process.platform, runtime: process.version }),
    );
  });
}

describe.runIf(process.platform === "win32")(
  "backup capture with a native Windows range lock",
  () => {
    it("recovers after an observed native read denial and external lock release", async ({
      signal,
    }) => {
      await exerciseNativeLock("transient", signal);
    }, 120_000);

    it("refuses a persistent native lock without publishing or changing source bytes", async ({
      signal,
    }) => {
      await exerciseNativeLock("persistent", signal);
    }, 120_000);
  },
);
