import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  K32EnumProcesses: vi.fn(),
  WTSEnumerateProcessesW: vi.fn(),
  WTSFreeMemory: vi.fn(),
  decode: vi.fn(),
  OpenProcess: vi.fn(),
  CloseHandle: vi.fn(),
  GetLastError: vi.fn(),
  GetExitCodeProcess: vi.fn(),
  GetProcessTimes: vi.fn(),
  NtQueryInformationProcess: vi.fn(),
  ReadProcessMemory: vi.fn(),
  EqualSid: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    decode: native.decode,
    load: () => ({
      func: (signature: string) => {
        const binding = Object.entries(native).find(([name]) => signature.includes(`${name}(`));
        if (!binding) {
          throw new Error("Unexpected native binding");
        }
        return binding[1];
      },
    }),
  }),
}));
import { readWindowsProcessCensus } from "./windows-process-census.js";

const pid = process.pid + 1;
const handle = 12n;
const memory = new Map<bigint, Buffer>();
const owners = new Map<number, bigint>();
const snapshotAddress = 0x9000n;
const selfSid = 0x5000n;
const systemSid = 0x6000n;
let narrow = false;

function peers() {
  return readWindowsProcessCensus(1_000).filter((observation) => observation.pid !== process.pid);
}

beforeEach(() => {
  narrow = false;
  memory.clear();
  owners.clear();
  owners.set(0, 0n).set(4, 0n).set(pid, 0n).set(process.pid, selfSid);
  native.WTSEnumerateProcessesW.mockReset().mockImplementation(
    (_server, _reserved, _version, pointer: Buffer, count: Buffer) => {
      const records = Buffer.alloc(owners.size * 24);
      [...owners].forEach(([processId, sid], index) => {
        records.writeUInt32LE(processId, index * 24 + 4);
        records.writeBigUInt64LE(sid, index * 24 + 16);
      });
      memory.set(snapshotAddress, records);
      pointer.writeBigUInt64LE(snapshotAddress);
      count.writeUInt32LE(owners.size);
      return 1;
    },
  );
  native.WTSFreeMemory.mockReset();
  native.decode.mockReset().mockImplementation((address: bigint, _type, length: number) => {
    const records = memory.get(address);
    if (!records || records.length < length) {
      throw new Error("Snapshot is unreadable.");
    }
    return records.subarray(0, length);
  });
  native.K32EnumProcesses.mockReset().mockImplementation(
    (bytes: Buffer, _size, returned: Buffer) => {
      [0, 4, pid, process.pid].forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
      returned.writeUInt32LE(16);
      return 1;
    },
  );
  native.OpenProcess.mockReset().mockReturnValue(handle);
  native.CloseHandle.mockReset().mockReturnValue(1);
  native.GetLastError.mockReset().mockReturnValue(5);
  native.GetExitCodeProcess.mockReset().mockImplementation((_handle, output: Buffer) => {
    output.writeUInt32LE(259);
    return 1;
  });
  native.EqualSid.mockReset().mockImplementation((left, right) => Number(left === right));
  native.GetProcessTimes.mockReset().mockImplementation((_handle, creation: Buffer) => {
    creation.writeBigUInt64LE(133_700_000_000_000_001n);
    return 1;
  });
  native.NtQueryInformationProcess.mockReset().mockImplementation(
    (_handle, kind, bytes: Buffer, _size, returned: Buffer) => {
      returned.writeUInt32LE(bytes.length);
      if (kind === 0) {
        bytes.writeBigUInt64LE(0x1000n, 8);
        bytes.writeBigUInt64LE(BigInt(pid), 32);
        bytes.writeBigUInt64LE(100n, 40);
      } else if (kind === 26) {
        bytes.writeBigUInt64LE(narrow ? 0x1000n : 0n);
      } else {
        throw new Error("Unexpected native process information class");
      }
      return 0;
    },
  );
  native.ReadProcessMemory.mockReset().mockImplementation(
    (_handle, address: bigint, bytes: Buffer, _size, returned: Buffer) => {
      const source = memory.get(address);
      if (!source) {
        return 0;
      }
      source.copy(bytes);
      returned.writeBigUInt64LE(BigInt(source.length));
      return 1;
    },
  );
});

function processParameters() {
  const peb = Buffer.alloc(narrow ? 20 : 40);
  const parameters = Buffer.alloc(narrow ? 72 : 128);
  const pointer = (bytes: Buffer, offset: number, value: number) => {
    if (narrow) {
      bytes.writeUInt32LE(value, offset);
    } else {
      bytes.writeBigUInt64LE(BigInt(value), offset);
    }
  };
  pointer(peb, narrow ? 16 : 32, 0x2000);
  parameters.writeUInt32LE(1, 8);
  const unicode = (offset: number, address: number, text: string) => {
    const bytes = Buffer.from(text, "utf16le");
    parameters.writeUInt16LE(bytes.length, offset);
    parameters.writeUInt16LE(bytes.length, offset + 2);
    pointer(parameters, offset + (narrow ? 4 : 8), address);
    memory.set(BigInt(address), bytes);
  };
  unicode(narrow ? 36 : 56, 0x3000, "C:\\retained runtime\\工作");
  unicode(narrow ? 64 : 112, 0x4000, 'node "C:\\retained runtime\\worker.js" --run=run-123');
  memory.set(0x1000n, peb);
  memory.set(0x2000n, parameters);
}

it.each([false, true])(
  "reads native/WOW64 argv, cwd and the canonical start identity (WOW64=%s)",
  (wow64) => {
    narrow = wow64;
    processParameters();
    expect(peers()).toEqual([
      {
        pid,
        parentPid: 100,
        startIdentity: "1725526400000",
        commandLine: 'node "C:\\retained runtime\\worker.js" --run=run-123',
        cwd: "C:\\retained runtime\\工作",
      },
    ]);
    expect(native.CloseHandle).toHaveBeenCalledWith(handle);
    expect(native.WTSFreeMemory).toHaveBeenCalledExactlyOnceWith(snapshotAddress);
  },
);

it.each([
  "denied handle",
  "denied memory",
  "short memory",
  "incomplete string",
  "unknown exit status",
  "identity changed",
])("keeps %s observations unknown", (failure) => {
  processParameters();
  if (failure === "denied handle") {
    native.OpenProcess.mockReturnValue(null);
  } else if (failure === "denied memory") {
    native.ReadProcessMemory.mockReturnValue(0);
  } else if (failure === "short memory") {
    memory.set(0x3000n, Buffer.from("x", "utf16le"));
  } else if (failure === "incomplete string") {
    memory.get(0x2000n)!.writeUInt16LE(1, 56);
  } else if (failure === "unknown exit status") {
    native.GetExitCodeProcess.mockReturnValue(0);
  } else {
    native.NtQueryInformationProcess.mockImplementation(
      (_handle, _kind, bytes: Buffer, _size, returned: Buffer) => {
        returned.writeUInt32LE(bytes.length);
        bytes.writeBigUInt64LE(BigInt(pid + 1), 32);
        return 0;
      },
    );
  }
  const [observed] = peers();
  expect(observed).toMatchObject({ pid });
  expect(observed?.cwd).toBeUndefined();
  expect(observed?.foreignOwner).toBeUndefined();
});

it.each(["SYSTEM", "same user", "missing SID", "WTS failure"])(
  "retains only verified foreign ownership when all process handles are denied (%s)",
  (owner) => {
    owners.set(pid, owner === "same user" ? selfSid : systemSid);
    if (owner === "missing SID") {
      owners.set(pid, 0n);
    } else if (owner === "WTS failure") {
      native.WTSEnumerateProcessesW.mockReturnValue(0);
    }
    native.OpenProcess.mockReturnValue(null);
    const [observed] = peers();
    expect(observed).toMatchObject({ pid });
    expect(observed?.commandLine).toBeUndefined();
    expect(observed?.cwd).toBeUndefined();
    expect(observed?.foreignOwner).toBe(owner === "SYSTEM" ? true : undefined);
  },
);

it("retains an unreadable PID omitted from the owner snapshot", () => {
  owners.delete(pid);
  native.OpenProcess.mockReturnValue(null);
  expect(peers()).toEqual([{ pid }]);
});

it("releases an unreadable owner snapshot and retains unknown ownership", () => {
  native.decode.mockImplementation(() => {
    throw new Error("Snapshot is unreadable.");
  });
  native.OpenProcess.mockReturnValue(null);
  expect(peers()).toEqual([{ pid }]);
  expect(native.WTSFreeMemory).toHaveBeenCalledExactlyOnceWith(snapshotAddress);
});

it("preserves readable foreign argv when cwd inspection is denied", () => {
  owners.set(pid, systemSid);
  processParameters();
  memory.delete(0x3000n);
  expect(peers()).toEqual([
    {
      pid,
      parentPid: 100,
      startIdentity: "1725526400000",
      commandLine: 'node "C:\\retained runtime\\worker.js" --run=run-123',
      cwd: undefined,
      foreignOwner: true,
    },
  ]);
});

it.each(["absent", "exited"])("excludes a kernel-confirmed %s process", (state) => {
  if (state === "absent") {
    native.OpenProcess.mockReturnValue(null);
    native.GetLastError.mockReturnValue(87);
  } else {
    native.GetExitCodeProcess.mockImplementation((_handle, output: Buffer) => {
      output.writeUInt32LE(0);
      return 1;
    });
  }
  expect(peers()).toEqual([]);
});

it("rejects a truncated PID census instead of claiming the host is empty", () => {
  native.K32EnumProcesses.mockImplementation((_bytes, size, returned: Buffer) => {
    returned.writeUInt32LE(size);
    return 1;
  });
  expect(() => [...readWindowsProcessCensus(1_000)]).toThrow("enumeration is incomplete");
});
