import { createRequire } from "node:module";

// Bun is optional; load only these libproc symbols at the Darwin census boundary.
type BunProcFfi = {
  dlopen: (
    path: string,
    symbols: Record<string, { args: string[]; returns: string }>,
  ) => {
    symbols: {
      proc_listpids: (type: number, info: number, buffer: Buffer | null, bytes: number) => number;
      proc_pidinfo: (
        pid: number,
        flavor: number,
        arg: number,
        buffer: Buffer,
        bytes: number,
      ) => number;
      __error: () => number;
    };
    close: () => void;
  };
  read: { i32: (address: number) => number };
};

const DARWIN_PROCESS_STATES = ["", "I", "R", "S", "T", "Z"];

type DarwinProcess = { pid: number; ppid: number; pgid: number; state: string; uid: number };

/** Apple's setuid ps cannot exec in Seatbelt; Bun already supplies an in-process native ABI. */
export function* readDarwinBunProcessCensus(timeoutMs: number): Generator<DarwinProcess> {
  const deadline = Date.now() + timeoutMs;
  const checkDeadline = () => {
    if (Date.now() >= deadline) {
      throw new Error("Process group census exceeded its deadline");
    }
  };
  // SAFETY: Darwin's public libproc ABI uses fixed-width fields on arm64 and x64.
  const ffi = createRequire(import.meta.url)("bun:ffi") as BunProcFfi;
  const library = ffi.dlopen("/usr/lib/libproc.dylib", {
    proc_listpids: { args: ["u32", "u32", "ptr", "i32"], returns: "i32" },
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  });
  try {
    const native = library.symbols;
    const { __error: errnoAddress } = native;
    const required = native.proc_listpids(1, 0, null, 0); // PROC_ALL_PIDS, bytes required.
    if (!Number.isInteger(required) || required <= 0) {
      throw new Error("Process group census is unavailable");
    }
    let pids: Buffer;
    let bytes: number;
    let capacity = required + 256;
    for (;;) {
      checkDeadline();
      // Match the existing ps output budget; overflow is unavailable, never an empty census.
      if (capacity > 4 * 1024 * 1024) {
        throw new Error("Process group census exceeds its size limit");
      }
      pids = Buffer.alloc(capacity);
      bytes = native.proc_listpids(1, 0, pids, pids.length);
      if (!Number.isInteger(bytes) || bytes <= 0 || bytes > pids.length || bytes % 4 !== 0) {
        throw new Error("Process group census is unavailable");
      }
      if (bytes < pids.length) {
        break;
      }
      // Process creation may fill the sized buffer; repeat instead of accepting truncation.
      capacity *= 2;
    }
    // PROC_PIDT_SHORTBSDINFO is the public 64-byte proc_bsdshortinfo layout.
    const info = Buffer.alloc(64);
    for (let offset = 0; offset < bytes; offset += 4) {
      checkDeadline();
      const pid = pids.readInt32LE(offset);
      if (pid === 0) {
        continue;
      }
      if (pid < 0) {
        throw new Error("Process group census is unavailable");
      }
      const size = native.proc_pidinfo(pid, 13, 0, info, info.length);
      if (size === 0 && ffi.read.i32(errnoAddress()) === 3) {
        continue; // ESRCH: this process disappeared after PID enumeration.
      }
      const state = DARWIN_PROCESS_STATES[info.readUInt32LE(12)];
      if (size !== info.length || info.readUInt32LE(0) !== pid || !state) {
        throw new Error(`Could not classify PID ${pid}: native process census is unavailable.`);
      }
      yield {
        pid,
        ppid: info.readUInt32LE(4),
        pgid: info.readUInt32LE(8),
        state,
        uid: info.readUInt32LE(36),
      };
    }
    checkDeadline();
  } finally {
    library.close();
  }
}
