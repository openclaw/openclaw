import { createRequire } from "node:module";

type WindowsProcessObservation = {
  pid: number;
  parentPid?: number;
  startIdentity?: string;
  commandLine?: string;
  cwd?: string;
  foreignOwner?: true;
};
let native: ReturnType<typeof loadNative> | undefined;

function loadNative() {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Windows process census requires a 64-bit runtime.");
  }
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  const security = koffi.load("advapi32.dll");
  const nt = koffi.load("ntdll.dll");
  const enumerate = kernel.func("int32_t __stdcall K32EnumProcesses(void *, uint32_t, void *)");
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t, int32_t, uint32_t)");
  const close = kernel.func("int32_t __stdcall CloseHandle(void *)");
  const error = kernel.func("uint32_t __stdcall GetLastError()");
  const exitCode = kernel.func("int32_t __stdcall GetExitCodeProcess(void *, void *)");
  const times = kernel.func(
    "int32_t __stdcall GetProcessTimes(void *, void *, void *, void *, void *)",
  );
  const read = kernel.func(
    "int32_t __stdcall ReadProcessMemory(void *, uintptr_t, void *, size_t, void *)",
  );
  const query = nt.func(
    "int32_t __stdcall NtQueryInformationProcess(void *, uint32_t, void *, uint32_t, void *)",
  );
  const equalSid = security.func("int32_t __stdcall EqualSid(void *, void *)");
  const sessions = koffi.load("wtsapi32.dll");
  const owners = sessions.func(
    "int32_t __stdcall WTSEnumerateProcessesW(void *, uint32_t, uint32_t, void *, void *)",
  );
  const free = sessions.func("void __stdcall WTSFreeMemory(void *)");
  const memory = (handle: bigint, address: bigint, length: number): Buffer => {
    const bytes = Buffer.alloc(length);
    const returned = Buffer.alloc(8);
    if (
      !address ||
      !read(handle, address, bytes, length, returned) ||
      returned.readBigUInt64LE() !== BigInt(length)
    ) {
      throw new Error("Process memory is unreadable.");
    }
    return bytes;
  };
  const parameters = (handle: bigint, observation: WindowsProcessObservation) => {
    const basic = Buffer.alloc(48);
    const wow64 = Buffer.alloc(8);
    const returned = Buffer.alloc(4);
    if (
      query(handle, 0, basic, basic.length, returned) < 0 ||
      returned.readUInt32LE() !== basic.length ||
      basic.readBigUInt64LE(32) !== BigInt(observation.pid) ||
      query(handle, 26, wow64, wow64.length, returned) < 0 ||
      returned.readUInt32LE() !== wow64.length
    ) {
      throw new Error("Process identity or architecture is unavailable.");
    }
    const narrow = wow64.readBigUInt64LE() !== 0n;
    const pointer = (bytes: Buffer, offset: number) =>
      narrow ? BigInt(bytes.readUInt32LE(offset)) : bytes.readBigUInt64LE(offset);
    // NT layouts: PEB.ProcessParameters, then RTL_USER_PROCESS_PARAMETERS strings.
    const peb = narrow ? wow64.readBigUInt64LE() : basic.readBigUInt64LE(8);
    const address = pointer(memory(handle, peb, narrow ? 20 : 40), narrow ? 16 : 32);
    const header = memory(handle, address, narrow ? 72 : 128);
    const string = (offset: number): string | undefined => {
      try {
        const length = header.readUInt16LE(offset);
        if (!length || length % 2 || length > header.readUInt16LE(offset + 2)) {
          return undefined;
        }
        const value = pointer(header, offset + (narrow ? 4 : 8));
        const location = header.readUInt32LE(8) & 1 ? value : address + value;
        return memory(handle, location, length).toString("utf16le");
      } catch {
        return undefined;
      }
    };
    observation.parentPid = Number(basic.readBigUInt64LE(40));
    observation.commandLine = string(narrow ? 64 : 112);
    observation.cwd = string(narrow ? 36 : 56);
  };
  return (deadline: number): WindowsProcessObservation[] => {
    const bytes = Buffer.alloc(4 * 65_536);
    const returned = Buffer.alloc(4);
    if (
      !enumerate(bytes, bytes.length, returned) ||
      returned.readUInt32LE() >= bytes.length ||
      returned.readUInt32LE() % 4
    ) {
      throw new Error("Windows process enumeration is incomplete.");
    }
    const pids = new Uint32Array(bytes.buffer, bytes.byteOffset, returned.readUInt32LE() / 4);
    const snapshot = new Map<number, bigint>(Array.from(pids, (pid) => [pid, 0n]));
    const allocation = Buffer.alloc(8);
    try {
      try {
        // WTS returns PID/SID pairs even for CSRSS; kernel-only rows remain owner-unknown.
        if (owners(null, 0, 1, allocation, returned) && returned.readUInt32LE() <= 65_536) {
          const records = Buffer.from(
            koffi.decode(allocation.readBigUInt64LE(), "uint8_t", returned.readUInt32LE() * 24),
          );
          for (let offset = 0; offset < records.length; offset += 24) {
            snapshot.set(records.readUInt32LE(offset + 4), records.readBigUInt64LE(offset + 16));
          }
        }
      } catch {
        snapshot.forEach((_sid, pid) => snapshot.set(pid, 0n));
      }
      const self = snapshot.get(process.pid);
      const observations = Array.from(snapshot, ([pid, owner]) => {
        if (Date.now() >= deadline) {
          throw new Error("Windows process census exceeded its deadline.");
        }
        if (pid === 0 || pid === 4) {
          // Idle/System have no user-mode argv/cwd.
          return undefined;
        }
        const observation: WindowsProcessObservation = { pid };
        if (self && owner && !equalSid(self, owner)) {
          observation.foreignOwner = true;
        }
        const handle: bigint | null =
          open(0x0410, 0, pid) ?? (error() === 87 ? null : open(0x1000, 0, pid));
        if (!handle) {
          return error() === 87 ? undefined : observation;
        }
        try {
          const state = Buffer.alloc(4);
          const known = exitCode(handle, state);
          if (!known || state.readUInt32LE() !== 259) {
            return known ? undefined : observation;
          }
          const created = Buffer.alloc(8);
          if (
            times(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) &&
            created.readBigUInt64LE()
          ) {
            observation.startIdentity = String(
              Number(created.readBigUInt64LE() / 10000n - 11644473600000n),
            );
          }
          try {
            parameters(handle, observation);
          } catch {
            // Missing argv/cwd stays unknown unless the owner is verified foreign.
          }
        } finally {
          close(handle);
        }
        return observation;
      });
      if (Date.now() >= deadline) {
        throw new Error("Windows process census exceeded its deadline.");
      }
      return observations.filter((observation) => observation !== undefined);
    } finally {
      if (allocation.readBigUInt64LE()) {
        free(allocation.readBigUInt64LE());
      }
    }
  };
}

/** Missing fields never establish absence for same-user or unknown-owner work. */
export function readWindowsProcessCensus(timeoutMs: number): WindowsProcessObservation[] {
  const deadline = Date.now() + timeoutMs;
  return (native ??= loadNative())(deadline);
}
