import { ChildProcess } from "node:child_process";
import { lstatSync, writeFileSync } from "node:fs";
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
const stage = temporary.make("openclaw-staging-users-");
const slot = temporary.make("slôt-");
const lock = join(slot, "lock");
beforeAll(() => writeFileSync(lock, "held lock fixture"));
beforeEach(() => {
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get: (target, key) => (key === "platform" ? "darwin" : Reflect.get(target, key)),
    }),
  );
});
afterEach(() => {
  command.mockReset();
  vi.unstubAllGlobals();
});

function response(
  options: Partial<Record<"stdout" | "stderr", string | Buffer>> & {
    code?: number;
    error?: Error;
  } = {},
) {
  command.mockImplementationOnce(async (invocation: RunManagedCommandOptions) => {
    const child = new ChildProcess();
    const streams = { stdout: new PassThrough(), stderr: new PassThrough() };
    Object.assign(child, streams);
    try {
      invocation.onReady?.(child);
      for (const stream of ["stdout", "stderr"] as const) {
        const data = options[stream];
        if (data) {
          streams[stream].emit("data", Buffer.from(data));
        }
      }
      if (options.error) {
        throw options.error;
      }
      return options.code ?? 1;
    } finally {
      Object.values(streams).forEach((stream) => stream.destroy());
    }
  });
}
const verify = (roots = [stage], ignoredFiles?: string[], signal?: AbortSignal) =>
  verifyNoStagingUsers({ roots, ignoredFiles, signal });

it("requires an empty successful-absence result for every staging root", async () => {
  response();
  response();
  await expect(verify([stage, slot])).resolves.toEqual({ ok: true });
  expect(command.mock.calls.map(([options]) => options.args.at(-1))).toEqual([stage, slot]);
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

it.each(["own", "extra", "foreign"])(
  "exempts only its own exact lock without disclosing paths (%s)",
  async (user) => {
    const extra = user === "extra";
    const pid = process.pid + Number(user === "foreign");
    response({
      stdout: `p${pid}\n${fileRecord(lock)}${extra ? fileRecord(stage) : ""}`,
      code: user === "own" ? 0 : 1,
    });
    await expect(verify(extra ? [stage, slot] : [slot], [lock])).resolves.toEqual(
      user !== "own"
        ? { ok: false, reason: `Live staging users remain (PIDs ${pid}).` }
        : { ok: true },
    );
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
  {
    reason: "missing executable",
    error: Object.assign(new Error("missing lsof"), { code: "ENOENT" }),
  },
])("refuses $reason", async (options) => {
  response(options);
  await expect(verify()).resolves.toEqual(
    "error" in options
      ? { ok: false, reason: "lsof could not verify the absence of staging users." }
      : expect.objectContaining({ ok: false }),
  );
});

it.each(["stdout", "stderr"] as const)(
  "bounds %s and preserves unjoined cleanup",
  async (stream) => {
    response({
      [stream]: Buffer.alloc(stream === "stdout" ? 1024 * 1024 + 1 : 64 * 1024 + 1, 120),
      error: Object.assign(new Error("fixture cleanup incomplete"), { processTreeState: "live" }),
    });
    await expect(verify()).resolves.toEqual({
      ok: false,
      reason: "lsof staging-user output exceeded its limit.",
      unjoined: true,
    });
    expect(command.mock.calls[0]![0].signal.aborted).toBe(true);
  },
);

it("refuses an already aborted request without spawning a scan", async () => {
  await expect(verify([stage], undefined, AbortSignal.abort())).resolves.toMatchObject({
    ok: false,
  });
  expect(command).not.toHaveBeenCalled();
});
