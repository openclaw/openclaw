import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MANAGED_HANDOFF_COMMAND_SOURCE } from "./update-managed-service-handoff-command-source.js";

type CommandResult = { code: number; stdout: string; stderr: string };
const output = (code = 1, stderr = ""): CommandResult => ({ code, stdout: "", stderr });
type RunServiceCommand = (
  ...args: [string, string[], (() => void)?, number?, number?]
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
  "bounds %s command duration",
  async (operation, deadline, cap, elapsed, closeCode?: number) => {
    const helper = createHelper(closeCode);
    const scheduled = operation.startsWith("/");
    const settled = vi.fn<(result: CommandResult) => void>();
    const command = scheduled ? "schtasks.exe" : operation;
    const args = scheduled ? [operation] : ["stop"];
    const completed = helper.run(command, args, undefined, deadline, cap).then(settled);
    if (scheduled) {
      helper.child.stderr.emit("data", "native diagnostic");
    } else {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(elapsed - (scheduled ? 0 : 15_000));
    const detail = `schtasks ${operation} timed out after ${elapsed}ms`;
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      output(scheduled ? 124 : 1, scheduled ? `${detail}\nnative diagnostic` : ""),
    );
    expect(helper.appendLog.mock.calls).toEqual(scheduled ? [[detail]] : []);
    await completed;
  },
);

it("does not dispatch a Scheduled Task command after its lease is lost", async () => {
  const helper = createHelper();
  helper.hasManagedUpdateLease.mockReturnValue(false);

  await expect(helper.run("schtasks.exe", ["/Run"])).resolves.toEqual(output());

  expect([helper.spawn.mock.calls, helper.appendLog.mock.calls]).toEqual([[], []]);
});

it.each([9_000, 1024 * 1024 + 1])(
  "preserves complete launchd inspections or refuses overflow (%i characters)",
  async (size) => {
    const helper = createHelper(0);
    const completed = helper.run("launchctl", ["print", "gui/501/ai.openclaw.gateway"]);
    const header = "gui/501/ai.openclaw.gateway = {\n";
    const body = "x".repeat(size);
    helper.child.stdout.emit("data", header);
    helper.child.stdout.emit("data", body);
    helper.child.stdout.emit("data", "\n\tpid = 4242\n}\n");
    helper.child.stderr.emit("data", "native diagnostic");
    helper.child.emit("close", 0);
    const result = await completed;
    if (size > 1024 * 1024) {
      expect(result).toEqual(
        output(1, "launchctl print exceeded the inspection output limit\nnative diagnostic"),
      );
    } else {
      expect(result).toEqual({
        code: 0,
        stdout: header + body + "\n\tpid = 4242\n}\n",
        stderr: "native diagnostic",
      });
    }
  },
);
