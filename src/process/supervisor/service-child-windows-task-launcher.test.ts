import koffi from "koffi";
import { beforeEach, expect, it, vi } from "vitest";
import { bindWindowsTaskLauncher } from "./service-child-windows-task-launcher.js";

const native = vi.hoisted(() => ({
  OpenProcess: vi.fn(),
  GetProcessTimes: vi.fn(),
  QueryFullProcessImageNameW: vi.fn(),
  NtQueryInformationProcess: vi.fn(),
  WaitForSingleObject: vi.fn(),
  DuplicateHandle: vi.fn(),
  AssignProcessToJobObject: vi.fn(),
  CloseHandle: vi.fn(),
}));

vi.mock("koffi", () => ({
  default: {
    pointer: () => null,
    out: () => null,
    inout: () => null,
    load: () => ({
      func: (_abi: string, name: string) => {
        const binding = Object.entries(native).find(([key]) => key === name)?.[1];
        if (!binding) {
          throw new Error(`Unexpected Windows binding: ${name}`);
        }
        return binding;
      },
    }),
  },
}));

vi.mock("./service-child-windows-job-native.js", async (original) => ({
  ...(await original<typeof import("./service-child-windows-job-native.js")>()),
  createWindowsJobBindings: () => ({
    assertLayouts: () => {},
    GetCurrentProcess: () => 1n,
    CreateJobObjectW: () => 4n,
    SetExtendedLimits: () => 1,
    extendedLimits: { BasicLimitInformation: { LimitFlags: 0x2000 } },
    extendedLimitsSize: 144,
    WaitForSingleObject: native.WaitForSingleObject,
    DuplicateHandle: native.DuplicateHandle,
    AssignProcessToJobObject: native.AssignProcessToJobObject,
    CloseHandle: native.CloseHandle,
    lastError: (operation: string) => new Error(`${operation} failed`),
    requireHandle: (handle: bigint | null, operation: string) => {
      if (!handle) {
        throw new Error(`${operation} failed`);
      }
      return handle;
    },
  }),
}));

const processes = new Map<
  bigint,
  { pid: number; parentPid: number; image: string; created: bigint }
>();

beforeEach(() => {
  vi.resetAllMocks();
  processes.clear();
  processes.set(1n, { pid: process.pid, parentPid: 101, image: "node.exe", created: 30n });
  processes.set(2n, { pid: 101, parentPid: 102, image: "cmd.exe", created: 20n });
  processes.set(3n, { pid: 102, parentPid: 103, image: "wscript.exe", created: 10n });
  native.OpenProcess.mockImplementation(
    (_access: number, _inherit: number, pid: number) =>
      [...processes].find(([, process]) => process.pid === pid)?.[0] ?? null,
  );
  native.NtQueryInformationProcess.mockImplementation(
    (handle: bigint, _kind: number, basic: Buffer, size: number, returned: number[]) => {
      const identity = processes.get(handle)!;
      basic.writeBigUInt64LE(BigInt(identity.pid), 32);
      basic.writeBigUInt64LE(BigInt(identity.parentPid), 40);
      returned[0] = size;
      return 0;
    },
  );
  native.QueryFullProcessImageNameW.mockImplementation(
    (handle: bigint, _flags: number, output: Buffer, chars: number[]) => {
      const image = `C:\\Windows\\System32\\${processes.get(handle)!.image}`;
      output.write(image, "utf16le");
      chars[0] = image.length;
      return 1;
    },
  );
  native.GetProcessTimes.mockImplementation((handle: bigint, creation: Buffer) => {
    creation.writeBigUInt64LE(processes.get(handle)!.created);
    return 1;
  });
  native.WaitForSingleObject.mockReturnValue(258);
  native.DuplicateHandle.mockImplementation(
    (_self: bigint, _job: bigint, _owner: bigint, output: bigint[]) => {
      output[0] = 5n;
      return 1;
    },
  );
  native.AssignProcessToJobObject.mockReturnValue(1);
  native.CloseHandle.mockReturnValue(1);
});

it.each(["cmd", "wscript"] as const)(
  "makes the live %s launcher the only outer Job owner",
  (launcher) => {
    bindWindowsTaskLauncher(koffi, launcher);

    const owner = launcher === "cmd" ? 2n : 3n;
    expect(native.OpenProcess.mock.calls).toEqual(
      launcher === "cmd"
        ? [[0x101440, 0, 101]]
        : [
            [0x101400, 0, 101],
            [0x101440, 0, 102],
          ],
    );
    expect(native.DuplicateHandle).toHaveBeenCalledExactlyOnceWith(1n, 4n, owner, [5n], 0, 0, 2);
    expect(native.AssignProcessToJobObject).toHaveBeenCalledExactlyOnceWith(4n, 1n);
    expect(native.CloseHandle.mock.calls).toEqual(
      launcher === "cmd" ? [[4n], [2n]] : [[4n], [3n], [2n]],
    );
  },
);

it.each(["wrong image", "recycled PID", "exited", "denied duplicate access"])(
  "rejects a CMD owner with %s before transferring the Job",
  (failure) => {
    if (failure === "wrong image") {
      processes.get(2n)!.image = "powershell.exe";
    } else if (failure === "recycled PID") {
      processes.get(2n)!.created = 31n;
    } else if (failure === "exited") {
      native.WaitForSingleObject.mockReturnValue(0);
    } else {
      native.OpenProcess.mockReturnValue(null);
    }

    expect(() => bindWindowsTaskLauncher(koffi, "cmd")).toThrow(
      failure === "exited"
        ? "CMD launcher is no longer live"
        : failure === "denied duplicate access"
          ? "OpenProcess(CMD) failed"
          : "lost its original CMD launcher",
    );
    expect(native.DuplicateHandle).not.toHaveBeenCalled();
    expect(native.AssignProcessToJobObject).not.toHaveBeenCalled();
    expect(native.CloseHandle.mock.calls).toEqual(
      failure === "denied duplicate access" ? [] : [[2n]],
    );
  },
);

it("keeps the WScript grandparent identity requirement for legacy launchers", () => {
  processes.get(3n)!.image = "taskeng.exe";

  expect(() => bindWindowsTaskLauncher(koffi, "wscript")).toThrow(
    "lost its original WScript launcher",
  );
  expect(native.DuplicateHandle).not.toHaveBeenCalled();
  expect(native.CloseHandle.mock.calls).toEqual([[3n], [2n]]);
});
