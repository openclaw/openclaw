import type { StdioOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runLinuxMemoryCommand } from "../../scripts/lib/managed-memory.mts";
import { hasLinuxMemoryContainment } from "../../scripts/lib/process-memory.mts";

const mocks = vi.hoisted(() => ({ control: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.control }));
afterEach(() => vi.restoreAllMocks());

const command = {
  bin: "fixture",
  memoryLimitBytes: 256 * 1024 ** 2,
  memoryScope: "openclaw-check-abcd.scope",
};
const response = (stdout: string) => ({ stdout, stderr: "", status: 0 });

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

it.for<StdioOptions>(["inherit", "pipe", "ignore", [0, 1, 2], [null, "pipe"]])(
  "preserves standard stdio %j",
  async (stdio) => {
    const memory = await import("../../scripts/lib/managed-memory.mts");
    const run = vi.spyOn(memory, "runLinuxMemoryCommand").mockResolvedValue(0);
    await runManagedCommand({ ...command, stdio, platform: "linux" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ stdio }), expect.any(Function));
  },
);

it.for<StdioOptions>([
  ["ignore", "pipe", "ipc"],
  ["ignore", "pipe", "pipe", "pipe"],
])("rejects unsupported stdio %j before entering containment", async (stdio) => {
  const memory = await import("../../scripts/lib/managed-memory.mts");
  const run = vi.spyOn(memory, "runLinuxMemoryCommand");
  await expect(runManagedCommand({ ...command, stdio, platform: "linux" })).rejects.toThrow(
    "do not support IPC or extra stdio descriptors",
  );
  expect(run).not.toHaveBeenCalled();
});

it.each([undefined, 1_001])(
  "keeps wall deadline ownership in the managed runner (%s)",
  async (timeoutMs) => {
    mocks.control.mockReturnValue(response("LoadState=not-found\n"));
    const run = vi.fn(async (_options: Parameters<typeof runLinuxMemoryCommand>[0]) => 0);
    await runLinuxMemoryCommand({ ...command, timeoutMs }, run);
    expect(
      run.mock.calls[0]?.[0]?.args?.filter((arg) => arg.startsWith("--property=RuntimeMaxSec=")),
    ).toEqual([]);
  },
);

it("forces remaining scope members before waiting for systemd cleanup", async () => {
  mocks.control.mockReset().mockReturnValue(response("LoadState=not-found\n"));
  await runLinuxMemoryCommand(command, async () => 0);
  expect(mocks.control.mock.calls.map((call) => call[1])).toEqual([
    ["--user", "show", "--property=LoadState", command.memoryScope],
    ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", command.memoryScope],
    ["--user", "stop", command.memoryScope],
    [
      "--user",
      "show",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=ControlGroup",
      command.memoryScope,
    ],
  ]);
});

it("does not start work when the systemd user manager is unavailable", async () => {
  mocks.control.mockReturnValue({ error: new Error("no user bus"), stdout: "", status: 1 });
  const run = vi.fn();
  await expect(runLinuxMemoryCommand(command, run)).rejects.toThrow("user manager");
  expect(run).not.toHaveBeenCalled();
});

it("preserves a pre-spawn failure without claiming an unjoined scope", async () => {
  mocks.control.mockReturnValue(response("LoadState=not-found\n"));
  const error = Object.assign(new Error("systemd-run missing"), { code: "ENOENT" });
  await expect(
    runLinuxMemoryCommand(command, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

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

it.each([undefined, "ENOENT"])(
  "preserves failure %s when descendant cleanup is uncertain",
  async (code) => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 6_000));
    mocks.control
      .mockReset()
      .mockReturnValue(response("LoadState=loaded\nActiveState=failed\n"))
      .mockReturnValueOnce(response("LoadState=not-found\n"));
    const original = Object.assign(new Error("workload failed"), { code });
    await expect(
      runLinuxMemoryCommand(command, async () => {
        throw original;
      }),
    ).rejects.toMatchObject({ cause: original });
  },
);

it("passes literal arguments and restores preloads only inside the bounded launcher", async () => {
  mocks.control.mockReturnValue(response("LoadState=not-found\n"));
  const run = vi.fn(async () => 0);
  await expect(
    runLinuxMemoryCommand(
      { ...command, args: ["$LITERAL"], env: { NODE_OPTIONS: "--require=workload" } },
      run,
    ),
  ).resolves.toBe(0);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
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
});

it.each([undefined, null])(
  "retains admission when a cleanup probe has no output (%s)",
  async (stdout) => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 6_000));
    mocks.control
      .mockReset()
      .mockReturnValue({
        error: Object.assign(new Error("spawn failed"), { code: "ENOMEM" }),
        stdout,
      })
      .mockReturnValueOnce(response("LoadState=not-found\n"));
    await expect(runLinuxMemoryCommand(command, async () => 0)).rejects.toMatchObject({
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState: "indeterminate",
    });
  },
);

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
        command.memoryScope,
      ),
    ).toBe(expected);
  },
);

it("records cgroup extinction after an inner process-group cleanup failure", async () => {
  mocks.control.mockReturnValue(response("LoadState=not-found\n"));
  const original = Object.assign(new Error("detached descendant held output"), {
    processTreeState: "live",
  });
  const result = runLinuxMemoryCommand(command, async () => {
    throw original;
  });
  await expect(result).rejects.toMatchObject({
    message: original.message,
    code: "EPROCESSGROUP_CLEANUP_FAILED",
    processTreeState: "terminated",
  });
  await expect(result).rejects.not.toHaveProperty("cause");
});
