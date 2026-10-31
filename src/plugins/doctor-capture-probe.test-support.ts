import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { workerData } from "node:worker_threads";

export type DoctorCaptureProbe = {
  signal: Int32Array;
  device: bigint;
  inode: bigint;
  failure?: string;
};

/** Pause only after the real guarded opener has admitted the synthetic source file. */
export function installDoctorCaptureProbe(probe: DoctorCaptureProbe, host: boolean) {
  const read = fs.readSync;
  const stat = fs.fstatSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    if (Atomics.load(probe.signal, 0) === 0) {
      const identity = stat(fd, { bigint: true });
      if (
        identity.dev === probe.device &&
        identity.ino === probe.inode &&
        Atomics.compareExchange(probe.signal, 0, 0, 1) === 0
      ) {
        Atomics.store(probe.signal, 1, host ? 1 : 0);
        Atomics.store(probe.signal, 3, Atomics.load(probe.signal, 2));
        Atomics.notify(probe.signal, 0);
        while (Atomics.load(probe.signal, 0) === 1) {
          Atomics.wait(probe.signal, 0, 1, 1_000);
        }
        if (probe.failure) {
          throw new Error(probe.failure);
        }
      }
    }
    return Reflect.apply(read, fs, [fd, ...args]);
  }) as typeof fs.readSync;
  return () => {
    fs.readSync = read;
  };
}

/** JS filesystem calls only; native helpers may perform additional operating-system calls. */
export const doctorFsOperations = [
  "openSync",
  "closeSync",
  "readSync",
  "writeSync",
  "readFileSync",
  "writeFileSync",
  "lstatSync",
  "statSync",
  "fstatSync",
  "realpathSync",
  "readdirSync",
  "mkdirSync",
  "chmodSync",
  "fchmodSync",
  "unlinkSync",
  "rmSync",
  "cpSync",
  "copyFileSync",
  "existsSync",
  "renameSync",
  "symlinkSync",
  "readlinkSync",
  "linkSync",
  "mkdtempSync",
  "accessSync",
  "opendirSync",
  "utimesSync",
  "realpathSync.native",
] as const;
export type DoctorFsMetrics = {
  calls: Int32Array;
  readBytes: Int32Array;
  writeBytes: Int32Array;
  rawCopyBytes: Int32Array;
};

export function installDoctorFsMetrics(metrics: DoctorFsMetrics, role: 0 | 1) {
  const originalStat = fs.statSync;
  const restores: Array<() => void> = [];
  for (const [index, name] of doctorFsOperations.entries()) {
    if (name === "realpathSync.native") {
      continue;
    }
    const original = fs[name];
    const wrapped = Object.assign((...args: unknown[]) => {
      Atomics.add(metrics.calls, role * doctorFsOperations.length + index, 1);
      const result = Reflect.apply(original, fs, args);
      if (name === "readSync") {
        Atomics.add(metrics.readBytes, role, result);
      }
      if (name === "writeSync") {
        Atomics.add(metrics.writeBytes, role, result);
      }
      if (name === "copyFileSync") {
        Atomics.add(metrics.rawCopyBytes, role, originalStat(args[0] as fs.PathLike).size);
      }
      return result;
    }, original);
    fs[name] = wrapped as never;
    restores.push(() => {
      fs[name] = original as never;
    });
  }
  const native = fs.realpathSync.native;
  fs.realpathSync.native = ((...args: unknown[]) => {
    Atomics.add(metrics.calls, role * doctorFsOperations.length + doctorFsOperations.length - 1, 1);
    return Reflect.apply(native, fs.realpathSync, args);
  }) as typeof native;
  restores.push(() => {
    fs.realpathSync.native = native;
  });
  return () => {
    for (const restore of restores.toReversed()) {
      restore();
    }
  };
}

type DoctorCopyTamper = {
  mode: "changed bytes" | "escaping link";
  basename: string;
  outside: string;
};

function installCopyTamper(tamper: DoctorCopyTamper) {
  const copy = fs.cpSync;
  let tampered = false;
  fs.cpSync = (from, to, options) => {
    copy(from, to, options);
    if (tampered) {
      return;
    }
    const find = (directory: string): string | undefined => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.name === tamper.basename && entry.isFile()) {
          return filename;
        }
        if (entry.isDirectory()) {
          const found = find(filename);
          if (found) {
            return found;
          }
        }
      }
      return undefined;
    };
    const target = find(String(to));
    if (!target) {
      throw new Error("fixture copy is missing its payload");
    }
    tampered = true;
    if (tamper.mode === "escaping link") {
      fs.unlinkSync(target);
      fs.symlinkSync(tamper.outside, target);
    } else {
      fs.writeFileSync(target, "changed");
    }
  };
}

function installResolutionCounters(counts: Int32Array) {
  const factory = (createRequire(import.meta.url)("jiti") as typeof import("jiti")).createJiti;
  globalThis.openclawStandaloneLoadJitiFactory =
    () =>
    (...args) => {
      Atomics.add(counts, 0, 1);
      return factory(...args);
    };
  const captureStack = Error.captureStackTrace.bind(Error);
  Error.captureStackTrace = (target, constructor) => {
    if (Error.stackTraceLimit === Infinity) {
      Atomics.add(counts, 1, 1);
    }
    captureStack(target, constructor);
  };
}

if (workerData?.doctorDependencyLinkFailure) {
  const symlink = fs.symlinkSync;
  fs.symlinkSync = (destination, filename, type) => {
    if (
      String(filename).includes("openclaw-plugin-build-") &&
      path.basename(String(filename)).startsWith("broken-dependency")
    ) {
      throw Object.assign(new Error("fixture dependency link permission denied"), {
        code: "EACCES",
      });
    }
    symlink(destination, filename, type);
  };
}

const tamper = workerData?.doctorCopyTamper as DoctorCopyTamper | undefined;
if (tamper) {
  installCopyTamper(tamper);
}
const resolutionCounts = workerData?.doctorResolutionCounts as Int32Array | undefined;
if (resolutionCounts) {
  installResolutionCounters(resolutionCounts);
}

const metrics = workerData?.doctorFsMetrics as DoctorFsMetrics | undefined;
if (metrics) {
  installDoctorFsMetrics(metrics, 1);
}
const probe = workerData?.doctorCaptureProbe as DoctorCaptureProbe | undefined;
if (probe) {
  installDoctorCaptureProbe(probe, false);
}
if (workerData?.doctorCaptureWorkerUrl) {
  await import(workerData.doctorCaptureWorkerUrl);
}
