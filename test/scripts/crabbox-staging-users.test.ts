import { ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { verifyNoStagingUsers } from "../../scripts/crabbox-staging-users.mts";
import type { RunManagedCommandOptions } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: command,
}));
const temporary = useAutoCleanupTempDirTracker(afterAll);
let stage: string;
let slot: string;
let lock: string;
beforeAll(() => {
  const root = realpathSync(temporary.make("openclaw-staging-users-"));
  stage = join(root, "stage");
  slot = join(root, "slôt");
  lock = join(slot, "lock");
  mkdirSync(stage);
  mkdirSync(slot);
  writeFileSync(lock, "held lock fixture");
});
beforeEach(() => {
  const original = process;
  vi.stubGlobal(
    "process",
    new Proxy(original, {
      get(target, key) {
        return key === "platform" ? "darwin" : Reflect.get(target, key);
      },
    }),
  );
});
afterEach(() => {
  command.mockReset();
  vi.unstubAllGlobals();
});

function response(
  options: {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    code?: number;
    error?: Error;
  } = {},
) {
  command.mockImplementationOnce(async (invocation: RunManagedCommandOptions) => {
    const child = new ChildProcess();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    try {
      invocation.onReady?.(child);
      if (options.stdout) {
        stdout.emit("data", Buffer.from(options.stdout));
      }
      if (options.stderr) {
        stderr.emit("data", Buffer.from(options.stderr));
      }
      if (options.error) {
        throw options.error;
      }
      return options.code ?? 1;
    } finally {
      stdout.destroy();
      stderr.destroy();
    }
  });
}

it("requires an empty successful-absence result for every staging root", async () => {
  response();
  response();
  await expect(verifyNoStagingUsers({ roots: [stage, slot] })).resolves.toEqual({ ok: true });
  expect(command.mock.calls.map(([options]) => options.args)).toEqual([
    ["-nP", "-FpfDi", "+D", stage],
    ["-nP", "-FpfDi", "+D", slot],
  ]);
  expect(command.mock.calls[0]![0]).toMatchObject({
    bin: "/usr/sbin/lsof",
    requireProcessTreeExit: true,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  });
});

function fileRecord(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return `f11\nD0x${stat.dev.toString(16)}\ni${stat.ino}\n`;
}

it.each([0, 1])(
  "exempts only its own exact held lock while preserving other current-process users (exit %s)",
  async (code) => {
    response({ stdout: `p${process.pid}\n${fileRecord(lock)}`, code });
    await expect(verifyNoStagingUsers({ roots: [slot], ignoredFiles: [lock] })).resolves.toEqual({
      ok: true,
    });
    response({ stdout: `p${process.pid}\n${fileRecord(lock)}${fileRecord(stage)}`, code });
    await expect(
      verifyNoStagingUsers({ roots: [stage, slot], ignoredFiles: [lock] }),
    ).resolves.toMatchObject({
      ok: false,
      reason: `Live staging users remain (PIDs ${process.pid}).`,
    });
  },
);

it.each([0, 1])(
  "refuses another process using the exempted lock without disclosing file paths (exit %s)",
  async (code) => {
    const otherPid = process.pid + 1;
    response({ stdout: `p${otherPid}\n${fileRecord(lock)}`, code });
    const outcome = await verifyNoStagingUsers({ roots: [slot], ignoredFiles: [lock] });
    expect(outcome).toEqual({ ok: false, reason: `Live staging users remain (PIDs ${otherPid}).` });
  },
);

it.each([
  { reason: "nonzero error exit", code: 2 },
  { reason: "empty success exit", code: 0 },
  { reason: "stderr on absence", stderr: "lsof warning\n" },
  { reason: "blank stdout on absence", stdout: "\n" },
  { reason: "missing final delimiter", stdout: "p123\nf3\nD0x1\ni2", code: 0 },
  { reason: "missing device", stdout: "p123\nf3\ni2\n", code: 0 },
  { reason: "missing inode", stdout: "p123\nf3\nD0x1\n", code: 0 },
  { reason: "duplicate device", stdout: "p123\nf3\nD0x1\nD0x2\ni2\n", code: 0 },
  { reason: "missing descriptor", stdout: "p123\nD0x1\ni2\n", code: 0 },
  { reason: "unknown field", stdout: "p123\nf3\nxunknown\n", code: 0 },
  { reason: "invalid pid", stdout: "p9007199254740999\nf3\nD0x1\ni2\n", code: 0 },
  { reason: "orphan pid", stdout: "p123\np124\nf3\nD0x1\ni2\n", code: 0 },
  { reason: "nul output", stdout: "p123\0f3\0D0x1\0i2\0\n", code: 0 },
])("refuses $reason", async (options) => {
  response(options);
  await expect(verifyNoStagingUsers({ roots: [stage] })).resolves.toMatchObject({ ok: false });
});

it.each(["stdout", "stderr"] as const)(
  "bounds %s while retaining unjoined cleanup evidence",
  async (stream) => {
    response({
      [stream]: Buffer.alloc(stream === "stdout" ? 1024 * 1024 + 1 : 64 * 1024 + 1, 120),
      error: Object.assign(new Error("fixture cleanup incomplete"), { processTreeState: "live" }),
    });
    await expect(verifyNoStagingUsers({ roots: [stage] })).resolves.toEqual({
      ok: false,
      reason: "lsof staging-user output exceeded its limit.",
      unjoined: true,
    });
    expect(command.mock.calls[0]![0].signal.aborted).toBe(true);
  },
);

it.each([
  {
    reason: "missing executable",
    error: Object.assign(new Error("missing lsof"), { code: "ENOENT" }),
  },
  { reason: "timeout", error: new Error("managed command timed out") },
])("refuses $reason instead of inferring no users", async ({ error }) => {
  response({ error });
  await expect(verifyNoStagingUsers({ roots: [stage] })).resolves.toEqual({
    ok: false,
    reason: "lsof could not verify the absence of staging users.",
  });
});

it("refuses an already aborted request without spawning a scan", async () => {
  await expect(
    verifyNoStagingUsers({ roots: [stage], signal: AbortSignal.abort() }),
  ).resolves.toMatchObject({ ok: false });
  expect(command).not.toHaveBeenCalled();
});
