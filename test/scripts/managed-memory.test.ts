import type { StdioOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runLinuxMemoryCommand } from "../../scripts/lib/managed-memory.mts";
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

it("removes signal ownership even when resource receipt release fails", async () => {
  const memory = await import("../../scripts/lib/managed-memory.mts");
  vi.spyOn(memory, "runLinuxMemoryCommand").mockResolvedValue(0);
  const error = new Error("receipt release failed");
  mocks.resourceOwner.mockReturnValue({
    claim: () => () => {
      throw error;
    },
  });
  const previousListeners = new Set(process.listeners("SIGTERM"));
  await expect(runManagedCommand({ ...command, platform: "linux" })).rejects.toBe(error);
  expect(new Set(process.listeners("SIGTERM"))).toEqual(previousListeners);
});

it.for([
  { kind: "abort", uncertain: false },
  { kind: "signal", uncertain: false },
  { kind: "abort", uncertain: true },
  { kind: "signal", uncertain: true },
])(
  "owns $kind cancellation until cgroup cleanup settles (uncertain=$uncertain)",
  async (params) => {
    const enteredCleanup = createDeferred();
    const cleanup = createDeferred<number>();
    const memory = await import("../../scripts/lib/managed-memory.mts");
    vi.spyOn(memory, "runLinuxMemoryCommand").mockImplementation(async () => {
      enteredCleanup.resolve();
      return await cleanup.promise;
    });
    const release = vi.fn();
    mocks.resourceOwner.mockReturnValue({ claim: () => release });
    const abort = new AbortController();
    const previousListeners = new Set(process.listeners("SIGTERM"));
    const onSignal = vi.fn();
    const result = runManagedCommand({
      ...command,
      platform: "linux",
      signal: abort.signal,
      onSignal,
    });
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
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
  },
);

it("snapshots Linux command inputs before loading containment", async () => {
  const memory = await import("../../scripts/lib/managed-memory.mts");
  const run = vi.spyOn(memory, "runLinuxMemoryCommand").mockResolvedValue(0);
  const args = ["original"];
  const env = { TMPDIR: process.cwd(), VALUE: "original" };
  const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
  const cwd = process.cwd();
  const result = runManagedCommand({ ...command, args, env, stdio, cwd: ".", platform: "linux" });
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
  const memory = await import("../../scripts/lib/managed-memory.mts");
  const run = vi.spyOn(memory, "runLinuxMemoryCommand");
  if (supported) {
    run.mockResolvedValue(0);
  }
  const result = runManagedCommand({ ...command, stdio, platform: "linux" });
  if (supported) {
    await result;
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ stdio }), expect.any(Function));
  } else {
    await expect(result).rejects.toThrow("do not support IPC or extra stdio descriptors");
    expect(run).not.toHaveBeenCalled();
  }
});

it("generates separate cleanup identities for concurrent invocations", async () => {
  mocks.control.mockReset().mockReturnValue(response("LoadState=not-found\n"));
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

it.each(["darwin", "win32"] as const)(
  "refuses an unqualified %s cap before starting a workload",
  async (platform) => {
    mocks.control.mockClear();
    await expect(runManagedCommand({ ...command, platform })).rejects.toThrow("not qualified");
    expect(mocks.control).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "preserves failure after cgroup extinction (unjoined=%s)",
  async (unjoined) => {
    mocks.control.mockReturnValue(response("LoadState=not-found\n"));
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

it.each([
  ["1", false],
  ["0", true],
])(
  "requires kernel extinction before releasing a failed scope (populated=%s)",
  async (populated, empty) => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 6_000));
    mocks.control
      .mockReset()
      .mockReturnValue(
        response(
          "LoadState=loaded\nActiveState=failed\nControlGroup=/user.slice/openclaw-check-abcd.scope\n",
        ),
      )
      .mockReturnValueOnce(response("LoadState=not-found\n"));
    vi.spyOn(fs, "readFileSync").mockReturnValue("populated " + populated + "\n");
    const run = runLinuxMemoryCommand(command, async () => 137);
    if (empty) {
      await expect(run).resolves.toBe(137);
    } else {
      await expect(run).rejects.toMatchObject({
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState: "indeterminate",
      });
    }
  },
);

it.each([
  ...[undefined, "ENOENT"].map((code) => ({
    probe: response("LoadState=loaded\nActiveState=failed\n"),
    original: Object.assign(new Error("workload failed"), { code }),
  })),
  ...[undefined, null].map((stdout) => ({
    probe: { error: Object.assign(new Error("spawn failed"), { code: "ENOMEM" }), stdout },
    original: undefined,
  })),
])(
  "retains admission and the original failure when cleanup is uncertain: %j",
  async ({ probe, original }) => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 6_000));
    mocks.control
      .mockReset()
      .mockReturnValue(probe)
      .mockReturnValueOnce(response("LoadState=not-found\n"));
    await expect(
      runLinuxMemoryCommand(command, async () => {
        if (original) {
          throw original;
        }
        return 0;
      }),
    ).rejects.toMatchObject({
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState: "indeterminate",
      cause: original,
    });
  },
);

it("bounds literal arguments and preloads while the managed runner owns deadlines and cleanup", async () => {
  mocks.control.mockReset().mockReturnValue(response("LoadState=not-found\n"));
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
    expect(
      hasLinuxMemoryContainment(
        command.memoryLimitBytes,
        {
          platform: "linux",
          fs: {
            readFileSync(file) {
              if (!(file in files)) {
                throw Object.assign(new Error(file), { code: "ENOENT" });
              }
              return files[file]!;
            },
          },
        },
        memoryScope,
      ),
    ).toBe(expected);
  },
);
