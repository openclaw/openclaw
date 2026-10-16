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

function startIdentity(seconds: bigint): string {
  const date = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(date.getTime()) || seconds <= 0n) {
    throw new Error("Native process start time is unavailable");
  }
  // Match LC_ALL=C TZ=UTC ps lstart: Codex persists these identities across
  // upgrades and Node/Bun switches. Command fingerprints guard second-level reuse.
  const [day, dayOfMonth, month, year, time] = date.toUTCString().split(" ");
  return `${day!.slice(0, -1)} ${month} ${Number(dayOfMonth)} ${time} ${year}`;
}

export type DarwinProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  uid: number;
  startedAt?: string;
};

/** Apple's setuid ps cannot exec in Seatbelt; Bun already supplies an in-process native ABI. */
export function* readDarwinBunProcessCensus(
  timeoutMs: number,
  selected?: readonly number[],
  includeStartTime = false,
): Generator<DarwinProcess> {
  const deadline = performance.now() + timeoutMs;
  const checkDeadline = () => {
    if (performance.now() >= deadline) {
      throw Object.assign(new Error("Process group census exceeded its deadline"), {
        code: "ETIMEDOUT",
      });
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
    let pids: Buffer;
    let bytes: number;
    if (selected) {
      pids = Buffer.alloc(selected.length * 4);
      selected.forEach((pid, index) => pids.writeInt32LE(pid, index * 4));
      bytes = pids.length;
    } else {
      const required = native.proc_listpids(1, 0, null, 0); // PROC_ALL_PIDS, bytes required.
      if (!Number.isInteger(required) || required <= 0) {
        throw new Error("Process group census is unavailable");
      }
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
    }
    // The public short layout is readable across UIDs. Full BSDINFO adds start
    // identity but Darwin restricts it to owned processes, even outside Seatbelt.
    const info = Buffer.alloc(includeStartTime ? 136 : 64);
    for (let offset = 0; offset < bytes; offset += 4) {
      checkDeadline();
      const pid = pids.readInt32LE(offset);
      if (pid === 0) {
        continue;
      }
      if (pid < 0) {
        throw new Error("Process group census is unavailable");
      }
      const size = native.proc_pidinfo(pid, includeStartTime ? 3 : 13, 0, info, info.length);
      const errno = size === 0 ? ffi.read.i32(errnoAddress()) : undefined;
      if (size === 0 && errno === 3) {
        continue; // ESRCH: this process disappeared after PID enumeration.
      }
      const state = DARWIN_PROCESS_STATES[info.readUInt32LE(includeStartTime ? 4 : 12)];
      if (size !== info.length || info.readUInt32LE(includeStartTime ? 12 : 0) !== pid || !state) {
        throw Object.assign(
          new Error(`Could not classify PID ${pid}: native process census is unavailable.`),
          {
            code: errno === 1 || errno === 13 ? "EPERM" : "EIO",
          },
        );
      }
      yield {
        pid,
        ppid: info.readUInt32LE(includeStartTime ? 16 : 4),
        pgid: info.readUInt32LE(includeStartTime ? 100 : 8),
        state,
        uid: info.readUInt32LE(includeStartTime ? 20 : 36),
        ...(includeStartTime ? { startedAt: startIdentity(info.readBigUInt64LE(120)) } : {}),
      };
    }
    checkDeadline();
  } finally {
    library.close();
  }
}
