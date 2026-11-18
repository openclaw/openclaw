import { createHash } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type {
  HashError,
  HashResult,
  PackageFileHashJob,
} from "./package-update-integrity-hasher.types.js";

const cancel: unknown = workerData?.cancel;
if (!parentPort || !(cancel instanceof Int32Array)) {
  throw new Error("Package file hasher requires its worker cancellation buffer");
}
const cancellation = cancel;
const port = parentPort;
const buffer = Buffer.allocUnsafe(64 * 1024);
const fields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
const unchanged = (job: PackageFileHashJob, stat: BigIntStats) =>
  job.ino !== 0n && fields.every((key) => job[key] === stat[key]);
const cancelled = new Error("Package file hashing cancelled");

function admit() {
  if (Atomics.load(cancellation, 0)) {
    throw cancelled;
  }
}

function hash(job: PackageFileHashJob): HashResult {
  admit();
  const fd = fs.openSync(
    job.file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    admit();
    if (!unchanged(job, fs.fstatSync(fd, { bigint: true }))) {
      throw new Error("Package rollback file changed before reading");
    }
    const digest = createHash("sha256");
    const size = Number(job.size);
    let position = 0;
    while (position < size) {
      admit();
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (count === 0) {
        throw new Error("Package rollback file changed while reading");
      }
      position += count;
      digest.update(buffer.subarray(0, count));
    }
    admit();
    if (!unchanged(job, fs.fstatSync(fd, { bigint: true }))) {
      throw new Error("Package rollback file changed while reading");
    }
    return { digest: digest.digest("hex") };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function serializeError(error: unknown): HashError {
  const field = (key: string): unknown =>
    typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
  const code = field("code");
  const errno = field("errno");
  const syscall = field("syscall");
  const path = field("path");
  const result: HashError = { message: error instanceof Error ? error.message : String(error) };
  if (typeof code === "string") {
    result.code = code;
  }
  if (typeof errno === "number") {
    result.errno = errno;
  }
  if (typeof syscall === "string") {
    result.syscall = syscall;
  }
  if (typeof path === "string") {
    result.path = path;
  }
  return result;
}

port.on("message", (jobs: PackageFileHashJob[] | "close") => {
  if (jobs === "close") {
    port.close();
    return;
  }
  const results = jobs.map((job): HashResult => {
    try {
      return hash(job);
    } catch (error) {
      return error === cancelled ? { cancelled: true } : { error: serializeError(error) };
    }
  });
  port.postMessage(results);
});
