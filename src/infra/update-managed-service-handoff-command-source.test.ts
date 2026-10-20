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
  ["/End", 2_400_000, 2_400_000, 15_000],
  ["/Run", undefined, undefined, 15_000],
  ["/End", 7_500, undefined, 7_500],
  ["/Run", undefined, 5_000, 5_000],
  ["/Run", undefined, undefined, 15_000, 0],
  ["systemctl", 120_000, 120_000, 120_000],
  ["launchctl", 120_000, 120_000, 120_000],
] as const)(
  "bounds %s to its native drain budget",
  async (operation, deadline, cap, elapsed, closeCode) => {
    const helper = createHelper(closeCode);
    const scheduled = operation.startsWith("/");
    let result: CommandResult | undefined;
    const completed = helper
      .run(
        scheduled ? "schtasks.exe" : operation,
        scheduled ? [operation, "/TN", "Synthetic Gateway"] : ["stop", "synthetic"],
        undefined,
        deadline,
        cap,
      )
      .then((value) => {
        result = value;
      });
    if (scheduled) {
      helper.child.stderr.emit("data", "native diagnostic");
    } else {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(result).toBeUndefined();
    }
    await vi.advanceTimersByTimeAsync(elapsed - (scheduled ? 0 : 15_000));
    const detail = `schtasks ${operation} timed out after ${elapsed}ms`;
    expect(result).toEqual({
      code: scheduled ? 124 : 1,
      stdout: "",
      stderr: scheduled ? `${detail}\nnative diagnostic` : "",
    });
    if (scheduled) {
      expect(helper.appendLog).toHaveBeenCalledWith(detail);
    } else {
      expect(helper.appendLog).not.toHaveBeenCalled();
    }
    await completed;
  },
);

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
