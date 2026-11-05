import { beforeEach, expect, it, vi } from "vitest";
import { bindWindowsTaskLauncher } from "./service-child-windows-task-launcher.js";

const native = vi.hoisted(() => ({ open: vi.fn(), bind: vi.fn(), identity: vi.fn() }));
vi.mock("@openclaw/proc-safe/identity", () => ({
  readProcessIdentity: native.identity,
}));
vi.mock("@openclaw/proc-safe/windows-job", () => ({
  PinnedProcess: { open: native.open },
  bindCurrentProcessLifetimeTo: native.bind,
}));

function processOwner(pid: number, parentPid: number, image: string, startTimeMicros: number) {
  return {
    identity: { pid, parentPid, startTimeMicros, startTimeResolutionMicros: 1, exited: false },
    imagePath: `C:\\Windows\\System32\\${image}`,
    close: vi.fn(),
  };
}
const processes = new Map<number, ReturnType<typeof processOwner>>();
beforeEach(() => {
  vi.resetAllMocks();
  processes.clear();
  processes.set(process.pid, processOwner(process.pid, 101, "node.exe", 30));
  processes.set(101, processOwner(101, 102, "cmd.exe", 20));
  processes.set(102, processOwner(102, 103, "wscript.exe", 10));
  native.identity.mockImplementation((pid: number) => processes.get(pid)?.identity ?? null);
  native.open.mockImplementation((pid: number) => processes.get(pid) ?? null);
});

it.each(["cmd", "wscript"] as const)(
  "pins and verifies the %s task owner before binding its lifetime",
  (launcher) => {
    bindWindowsTaskLauncher(launcher);
    expect(native.bind).toHaveBeenCalledExactlyOnceWith(
      processes.get(launcher === "cmd" ? 101 : 102),
    );
    expect(native.identity).toHaveBeenCalledExactlyOnceWith(process.pid);
    expect(native.open.mock.calls).toEqual(
      launcher === "cmd"
        ? [[101, { access: "lifetime-owner" }]]
        : [
            [101, { access: "observe" }],
            [102, { access: "lifetime-owner" }],
          ],
    );
    expect(processes.get(101)!.close).toHaveBeenCalledOnce();
    expect(processes.get(102)!.close).toHaveBeenCalledTimes(launcher === "cmd" ? 0 : 1);
  },
);

it.each(["wrong image", "recycled PID", "exited", "absent", "denied"])(
  "rejects a CMD owner with %s before transferring the Job",
  (failure) => {
    const cmd = processes.get(101)!;
    if (failure === "wrong image") {
      cmd.imagePath = "C:\\Windows\\System32\\powershell.exe";
    } else if (failure === "recycled PID") {
      cmd.identity.startTimeMicros = 31;
    } else if (failure === "exited") {
      cmd.identity.exited = true;
    } else if (failure === "absent") {
      processes.delete(101);
    } else {
      native.open.mockImplementation((pid: number) => {
        if (pid === 101) {
          throw new Error("access denied");
        }
        return processes.get(pid);
      });
    }
    expect(() => bindWindowsTaskLauncher("cmd")).toThrow(
      failure === "exited"
        ? "CMD launcher is no longer live"
        : failure === "absent"
          ? "CMD is no longer present"
          : failure === "denied"
            ? "access denied"
            : "lost its original CMD launcher",
    );
    expect(native.bind).not.toHaveBeenCalled();
    expect(cmd.close).toHaveBeenCalledTimes(failure === "absent" || failure === "denied" ? 0 : 1);
  },
);

it.each(["wrong image", "recycled PID", "exited", "CMD exited"])(
  "keeps the WScript grandparent identity requirement when %s",
  (failure) => {
    const host = processes.get(102)!;
    if (failure === "wrong image") {
      host.imagePath = "C:\\Windows\\System32\\taskeng.exe";
    } else if (failure === "recycled PID") {
      host.identity.startTimeMicros = 21;
    } else if (failure === "exited") {
      host.identity.exited = true;
    } else {
      processes.get(101)!.identity.exited = true;
    }
    expect(() => bindWindowsTaskLauncher("wscript")).toThrow(
      failure === "exited"
        ? "WScript launcher is no longer live"
        : failure === "CMD exited"
          ? "CMD launcher is no longer live"
          : "lost its original WScript launcher",
    );
    expect(native.bind).not.toHaveBeenCalled();
    expect(processes.get(101)!.close).toHaveBeenCalledOnce();
    expect(host.close).toHaveBeenCalledOnce();
  },
);
