import type { StdioOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runLinuxMemoryCommand } from "../../scripts/lib/managed-memory.mts";
import * as memory from "../../scripts/lib/managed-memory.mts";
import { hasLinuxMemoryContainment } from "../../scripts/lib/process-memory.mts";
import { createDeferred } from "../helpers/promise.js";

const mocks = vi.hoisted(() => ({
  control: vi.fn(),
  uuid: vi.fn(() => "abcd"),
  resourceOwner: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: mocks.control }));
vi.mock("node:crypto", () => ({ randomUUID: mocks.uuid }));
vi.mock("../../scripts/lib/vitest-resource-ownership.mts", () => ({
  findVitestResourceOwner: mocks.resourceOwner,
}));
afterEach(() => {
  vi.restoreAllMocks();
  mocks.resourceOwner.mockReset();
});

const command = {
  bin: "fixture",
  memoryLimitBytes: 256 * 1024 ** 2,
};
const memoryScope = "openclaw-check-abcd.scope";
const response = (stdout: string) => ({ stdout, stderr: "", status: 0 });
beforeEach(() => mocks.control.mockReset().mockReturnValue(response("LoadState=not-found\n")));
function probeCleanup(probe: unknown) {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 6_000));
  mocks.control
    .mockReset()
    .mockReturnValue(probe)
    .mockReturnValueOnce(response("LoadState=not-found\n"));
}
const cleanupFailure = { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "indeterminate" };
const linuxCommand = (options: Partial<Parameters<typeof runManagedCommand>[0]> = {}) =>
  runManagedCommand({ ...command, platform: "linux", ...options });

it("removes signal listeners when receipt release throws", async () => {
  vi.spyOn(memory, "runLinuxMemoryCommand").mockResolvedValue(0);
  const error = new Error("receipt release failed");
  mocks.resourceOwner.mockReturnValue({
    claim: () => () => {
      throw error;
    },
  });
  const previousListeners = new Set(process.listeners("SIGTERM"));
  await expect(linuxCommand()).rejects.toBe(error);
  expect(new Set(process.listeners("SIGTERM"))).toEqual(previousListeners);
});

it.for([
  { kind: "abort", uncertain: false },
  { kind: "signal", uncertain: false },
  { kind: "abort", uncertain: true },
  { kind: "signal", uncertain: true },
])("owns $kind through cleanup (uncertain=$uncertain)", async (params) => {
  const enteredCleanup = createDeferred();
  const cleanup = createDeferred<number>();
  vi.spyOn(memory, "runLinuxMemoryCommand").mockImplementation(async () => {
    enteredCleanup.resolve();
    return await cleanup.promise;
  });
  const release = vi.fn();
  mocks.resourceOwner.mockReturnValue({ claim: () => release });
  const abort = new AbortController();
  const previousListeners = new Set(process.listeners("SIGTERM"));
  const onSignal = vi.fn();
  const result = linuxCommand({ signal: abort.signal, onSignal });
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void result.then(markSettled, markSettled);
  await enteredCleanup.promise;
  if (params.kind === "abort") {
    abort.abort();
  } else {
    // Invoke only this command's listener; never signal the shared test process.
    const handler = process
      .listeners("SIGTERM")
      .find((listener) => !previousListeners.has(listener));
    expect(handler).toBeTypeOf("function");
    handler!("SIGTERM");
    expect(onSignal).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  }
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(release).not.toHaveBeenCalled();
  if (params.uncertain) {
    const failure = Object.assign(new Error("scope still populated"), {
      processTreeState: "live",
    });
    cleanup.reject(failure);
    await expect(result).rejects.toBe(failure);
    expect(release).not.toHaveBeenCalled();
  } else {
    cleanup.resolve(0);
    if (params.kind === "abort") {
      await expect(result).rejects.toMatchObject({ code: "ABORT_ERR" });
    } else {
      await expect(result).resolves.toBe(143);
    }
    expect(release).toHaveBeenCalledOnce();
  }
  expect(new Set(process.listeners("SIGTERM"))).toEqual(previousListeners);
});

it("snapshots inputs before containment loads", async () => {
  const run = vi.spyOn(memory, "runLinuxMemoryCommand").mockResolvedValue(0);
  const args = ["original"];
  const env = { TMPDIR: process.cwd(), VALUE: "original" };
  const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
  const cwd = process.cwd();
  const result = linuxCommand({ args, env, stdio, cwd: "." });
  vi.spyOn(process, "cwd").mockReturnValue(path.dirname(cwd));
  args[0] = "mutated";
  env.VALUE = "mutated";
  stdio[1] = "ignore";
  await expect(result).resolves.toBe(0);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      args: ["original"],
      env: { ...env, VALUE: "original" },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    expect.any(Function),
  );
});

it.each<{ stdio: StdioOptions; supported: boolean }>([
  { stdio: "inherit", supported: true },
  { stdio: ["ignore", "pipe", "ipc"], supported: false },
  { stdio: ["ignore", "pipe", "pipe", "pipe"], supported: false },
])("admits supported stdio only: $stdio", async ({ stdio, supported }) => {
  const run = vi.spyOn(memory, "runLinuxMemoryCommand");
  if (supported) {
    run.mockResolvedValue(0);
  }
  const result = linuxCommand({ stdio });
  if (supported) {
    await result;
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ stdio }), expect.any(Function));
  } else {
    await expect(result).rejects.toThrow("do not support IPC or extra stdio descriptors");
    expect(run).not.toHaveBeenCalled();
  }
});

it("isolates concurrent cleanup identities", async () => {
  mocks.uuid.mockReturnValueOnce("aaaa").mockReturnValueOnce("bbbb");
  const scopes: string[] = [];
  const run = vi.fn(async () => 0);
  await Promise.all(
    [0, 1].map(() =>
      runLinuxMemoryCommand({ ...command, onMemoryScope: (unit) => scopes.push(unit) }, run),
    ),
  );
  expect(scopes).toEqual(["openclaw-check-aaaa.scope", "openclaw-check-bbbb.scope"]);
  expect(run.mock.calls).toHaveLength(2);
  for (const unit of scopes) {
    expect(mocks.control).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
      expect.any(Object),
    );
  }
});

it.each([
  { reason: "existing scope", probe: response("LoadState=loaded\n") },
  {
    reason: "unavailable user manager",
    probe: { error: new Error("no user bus"), stdout: "", status: 1 },
  },
])("refuses $reason without launching or stopping it", async ({ probe }) => {
  mocks.control.mockReset().mockReturnValue(probe);
  const run = vi.fn();
  await expect(runLinuxMemoryCommand(command, run)).rejects.toThrow("user manager");
  expect(run).not.toHaveBeenCalled();
  expect(mocks.control).toHaveBeenCalledTimes(1);
});

it("rejects unqualified darwin containment before launch", async () => {
  mocks.control.mockClear();
  await expect(runManagedCommand({ ...command, platform: "darwin" })).rejects.toThrow(
    "not qualified",
  );
  expect(mocks.control).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves failure after cgroup extinction (unjoined=%s)",
  async (unjoined) => {
    const original = unjoined
      ? Object.assign(new Error("detached descendant held output"), { processTreeState: "live" })
      : Object.assign(new Error("systemd-run missing"), { code: "ENOENT" });
    const result = runLinuxMemoryCommand(command, async () => {
      throw original;
    });
    if (unjoined) {
      await expect(result).rejects.toMatchObject({
        message: original.message,
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState: "terminated",
      });
      await expect(result).rejects.not.toHaveProperty("cause");
    } else {
      await expect(result).rejects.toBe(original);
    }
  },
);

const failedScope = response(
  "LoadState=loaded\nActiveState=failed\nControlGroup=/user.slice/openclaw-check-abcd.scope\n",
);
it.each<{ label: string; probe: unknown; populated?: string; original?: Error }>([
  { label: "populated kernel group", probe: failedScope, populated: "1" },
  { label: "empty kernel group", probe: failedScope, populated: "0" },
  {
    label: "missing group with failed workload",
    probe: response("LoadState=loaded\nActiveState=failed\n"),
    original: Object.assign(new Error("workload failed"), { code: "ENOENT" }),
  },
  {
    label: "failed manager probe",
    probe: {
      error: Object.assign(new Error("spawn failed"), { code: "ENOMEM" }),
      stdout: undefined,
    },
  },
])(
  "releases admission only with verified extinction: $label",
  async ({ probe, original, populated }) => {
    probeCleanup(probe);
    if (populated !== undefined) {
      vi.spyOn(fs, "readFileSync").mockReturnValue(`populated ${populated}\n`);
    }
    const result = runLinuxMemoryCommand(command, async () => {
      if (original) {
        throw original;
      }
      return populated === undefined ? 0 : 137;
    });
    if (populated === "0") {
      await expect(result).resolves.toBe(137);
    } else {
      await expect(result).rejects.toMatchObject({
        ...cleanupFailure,
        ...(populated === undefined ? { cause: original } : {}),
      });
    }
  },
);

it("bounds arguments and preloads without owning deadlines", async () => {
  const run = vi.fn(async (_options: Parameters<typeof runLinuxMemoryCommand>[0]) => 0);
  await expect(
    runLinuxMemoryCommand(
      {
        ...command,
        timeoutMs: 1_001,
        args: ["$LITERAL"],
        env: { NODE_OPTIONS: "--require=workload" },
      },
      run,
    ),
  ).resolves.toBe(0);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      requireProcessTreeExit: true,
      args: expect.arrayContaining([
        "--expand-environment=no",
        "--property=MemoryMax=268435456",
        "--property=MemorySwapMax=0",
        "--property=OOMPolicy=kill",
        "$LITERAL",
      ]),
      env: { OPENCLAW_MANAGED_NODE_OPTIONS: "--require=workload" },
    }),
  );
  expect(
    run.mock.calls[0]?.[0]?.args?.filter((arg) => arg.startsWith("--property=RuntimeMaxSec=")),
  ).toEqual([]);
  expect(mocks.control.mock.calls.map((call) => call[1])).toEqual([
    ["--user", "show", "--property=LoadState", memoryScope],
    ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", memoryScope],
    ["--user", "stop", memoryScope],
    [
      "--user",
      "show",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=ControlGroup",
      memoryScope,
    ],
  ]);
});

it.each([
  { scope: "openclaw-check-abcd.scope", swap: "0", group: "1", expected: true },
  { scope: "other.scope", swap: "0", group: "1", expected: false },
  { scope: "openclaw-check-abcd.scope", swap: "max", group: "1", expected: false },
  { scope: "openclaw-check-abcd.scope", swap: "0", group: "0", expected: false },
])(
  "qualifies the owned kernel cgroup only: $scope/$swap/$group",
  ({ scope, swap, group, expected }) => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/user.slice/" + scope + "\n",
      "/proc/self/mountinfo": "29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
      ["/sys/fs/cgroup/user.slice/" + scope + "/memory.max"]: "268435456",
      ["/sys/fs/cgroup/user.slice/" + scope + "/memory.swap.max"]: swap,
      ["/sys/fs/cgroup/user.slice/" + scope + "/memory.oom.group"]: group,
      "/sys/fs/cgroup/user.slice/memory.max": "268435456",
      "/sys/fs/cgroup/user.slice/memory.swap.max": "0",
      "/sys/fs/cgroup/user.slice/memory.oom.group": "1",
    };
    const readFileSync = (file: string) => {
      if (!(file in files)) {
        throw Object.assign(new Error(file), { code: "ENOENT" });
      }
      return files[file]!;
    };
    const options = { platform: "linux", fs: { readFileSync } } as const;
    expect(hasLinuxMemoryContainment(command.memoryLimitBytes, options, memoryScope)).toBe(
      expected,
    );
  },
);
