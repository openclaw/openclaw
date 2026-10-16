import { afterEach, expect, it, vi } from "vitest";
import * as identity from "../shared/pid-alive.js";
import * as groups from "./child-process-tree.js";
import { settleCommandProcessGroups } from "./command-process-custody.js";
import { COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS } from "./exec-spawn.js";
import * as termination from "./kill-tree.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32")(
  "never signals an unknown, orphaned, or recycled group leader",
  async () => {
    const kill = vi.spyOn(termination, "killProcessTree").mockReturnValue(undefined);
    vi.spyOn(groups, "isChildProcessTreeAlive").mockImplementation(({ pid }) => pid !== 4244);
    vi.spyOn(identity, "getProcessInstanceStartTime").mockImplementation((pid) =>
      pid === 4242 ? 2 : null,
    );
    const result = await settleCommandProcessGroups([
      { pid: 4241, startedAt: null },
      { pid: 4242, startedAt: 1 },
      { pid: 4243, startedAt: 1 },
      { pid: 4244, startedAt: null },
    ]);
    expect(result).toMatchObject({ settled: false, pids: [4241, 4242, 4243] });
    expect(kill).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === "win32")(
  "retains a verified group when forced cleanup cannot observe extinction",
  async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(termination, "killProcessTree").mockReturnValue(undefined);
    vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValue(true);
    vi.spyOn(identity, "getProcessInstanceStartTime").mockReturnValue(1);
    const result = settleCommandProcessGroups([{ pid: 4242, startedAt: 1 }]);
    await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS);
    expect(await result).toMatchObject({ settled: false, pids: [4242] });
    expect(kill).toHaveBeenCalledExactlyOnceWith(4242, { detached: true, force: true });
  },
);

it.skipIf(process.platform === "win32")(
  "confirms a killed group that outlives the cooperative grace",
  async () => {
    vi.useFakeTimers();
    let disappearsAt = Number.POSITIVE_INFINITY;
    const kill = vi.spyOn(termination, "killProcessTree").mockImplementation(() => {
      disappearsAt = Date.now() + 1_000;
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("synthetic group probe"), {
        code: Date.now() < disappearsAt ? "EPERM" : "ESRCH",
      });
    });
    vi.spyOn(identity, "getProcessInstanceStartTime").mockReturnValue(1);
    const result = settleCommandProcessGroups([{ pid: 4242, startedAt: 1 }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ settled: true, pids: [] });
    expect(kill).toHaveBeenCalledExactlyOnceWith(4242, { detached: true, force: true });
  },
);
