import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MANAGED_HANDOFF_COMMAND_SOURCE } from "./update-managed-service-handoff-command-source.js";

type CommandResult = { code: number; stdout: string; stderr: string };
type RunServiceCommand = (
  command: string,
  args: string[],
  onSpawn?: () => void,
  deadline?: number,
  timeoutCap?: number,
) => Promise<CommandResult>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function createHelper(closeCode: number | null = null) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
  });
  const hasManagedUpdateLease = vi.fn(() => true);
  const appendLog = vi.fn<(line: string) => void>();
  const spawn = vi.fn((_command: string, _args: string[], options: { timeout: number }) => {
    queueMicrotask(() => child.emit("spawn"));
    setTimeout(() => {
      child.killed = true;
      child.emit("close", closeCode, "SIGKILL");
    }, options.timeout);
    return child;
  });
  const run: RunServiceCommand = runInNewContext(
    `${MANAGED_HANDOFF_COMMAND_SOURCE}\nrunServiceCommand;`,
    { spawn, params: { recoveryTimeoutMs: 2_400_000 }, hasManagedUpdateLease, appendLog, Date },
  );
  return { child, run, spawn, hasManagedUpdateLease, appendLog };
}

it.each([
  { operation: "/End", deadline: 2_400_000, cap: 2_400_000, elapsed: 15_000 },
  { operation: "/Run", deadline: undefined, cap: undefined, elapsed: 15_000 },
  { operation: "/End", deadline: 7_500, cap: undefined, elapsed: 7_500 },
  { operation: "/Run", deadline: undefined, cap: 5_000, elapsed: 5_000 },
  { operation: "/Run", deadline: undefined, cap: undefined, elapsed: 15_000, closeCode: 0 },
])(
  "bounds stalled schtasks $operation to $elapsed ms and names the operation",
  async (scenario) => {
    const helper = createHelper(scenario.closeCode);
    let result: CommandResult | undefined;
    const completed = helper
      .run(
        "schtasks.exe",
        [scenario.operation, "/TN", "Synthetic Gateway"],
        undefined,
        scenario.deadline,
        scenario.cap,
      )
      .then((value) => {
        result = value;
      });
    helper.child.stderr.emit("data", "native diagnostic");

    await vi.advanceTimersByTimeAsync(scenario.elapsed);

    const detail = `schtasks ${scenario.operation} timed out after ${scenario.elapsed}ms`;
    expect(result).toEqual({ code: 124, stdout: "", stderr: `${detail}\nnative diagnostic` });
    expect(helper.appendLog).toHaveBeenCalledWith(detail);
    await completed;
  },
);

it.each(["systemctl", "launchctl"])("preserves the %s supervisor drain budget", async (command) => {
  const helper = createHelper();
  let result: CommandResult | undefined;
  const completed = helper
    .run(command, ["stop", "synthetic"], undefined, 120_000, 120_000)
    .then((value) => {
      result = value;
    });

  await vi.advanceTimersByTimeAsync(15_000);
  expect(result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(105_000);
  expect(result).toEqual({ code: 1, stdout: "", stderr: "" });
  expect(helper.appendLog).not.toHaveBeenCalled();
  await completed;
});

it("does not dispatch a Scheduled Task command after its lease is lost", async () => {
  const helper = createHelper();
  helper.hasManagedUpdateLease.mockReturnValue(false);

  await expect(helper.run("schtasks.exe", ["/Run"])).resolves.toEqual({
    code: 1,
    stdout: "",
    stderr: "",
  });

  expect(helper.spawn).not.toHaveBeenCalled();
  expect(helper.appendLog).not.toHaveBeenCalled();
});
