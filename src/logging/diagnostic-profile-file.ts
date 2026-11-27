import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { ProfileFailure, type DiagnosticProfileOutcome } from "./diagnostic-profile.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const WRITE_CHUNK_BYTES = 64 * 1024;

/** Successful operator artifacts are retained until manually removed. */
export async function reserveDiagnosticProfileFile(
  kind: "cpu" | "heap" | "heap-profile",
  assertActive: () => void,
) {
  const directory = path.join(resolveStateDir(), "diagnostics");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Native heap snapshots do not use the bounded profile writer.
  if (kind !== "heap") {
    const space = await fs.statfs(directory);
    if (space.bavail * space.bsize < MAX_FILE_BYTES) {
      throw new ProfileFailure("insufficient-disk-space");
    }
  }
  assertActive();
  const filename = path.join(
    directory,
    `${kind}-${new Date().toISOString().replaceAll(":", "-")}.${kind === "cpu" ? "cpuprofile" : kind === "heap" ? "heapsnapshot" : "heapprofile"}`,
  );
  return { path: filename, handle: await fs.open(filename, "wx", 0o600) };
}

type DiagnosticProfileFile = Awaited<ReturnType<typeof reserveDiagnosticProfileFile>>;

export async function writeDiagnosticProfileParts(
  file: DiagnosticProfileFile,
  parts: Iterable<string>,
  assertActive: () => void,
  settleWrite?: (write: Promise<void>) => Promise<void>,
) {
  let sizeBytes = 0;
  let chunk = "";
  let chunkBytes = 0;
  const flush = () => {
    assertActive();
    const write = file.handle.writeFile(chunk, "utf8");
    return settleWrite ? settleWrite(write) : write;
  };
  // Bound encoding work between asynchronous writes rather than stringifying the full graph.
  for (const part of parts) {
    const bytes = Buffer.byteLength(part);
    sizeBytes += bytes;
    if (sizeBytes > MAX_FILE_BYTES) {
      throw new ProfileFailure("profile-too-large");
    }
    chunk += part;
    chunkBytes += bytes;
    if (chunkBytes >= WRITE_CHUNK_BYTES) {
      await flush();
      chunk = "";
      chunkBytes = 0;
    }
  }
  if (chunk) {
    await flush();
  }
  return sizeBytes;
}

export async function settleDiagnosticProfileFile<Result>(
  artifact: DiagnosticProfileFile | undefined,
  outcome: DiagnosticProfileOutcome<Result>,
): Promise<DiagnosticProfileOutcome<Result>> {
  if (!artifact) {
    return outcome;
  }
  const closeFailed = await artifact.handle.close().then(
    () => false,
    () => true,
  );
  if (outcome.status === "unavailable" || closeFailed) {
    const removalFailed = await fs.unlink(artifact.path).then(
      () => false,
      () => true,
    );
    if (outcome.status === "unavailable") {
      outcome.cleanupFailed ||= closeFailed || removalFailed;
    } else {
      return { status: "unavailable", reason: "cleanup-failed", cleanupFailed: true };
    }
  }
  return outcome;
}
