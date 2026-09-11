import fs from "node:fs/promises";
import path from "node:path";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { MAX_MANIFEST_BYTES, statOrMissing } from "./update-recovery-backup-files.js";

const RESERVE_BYTES = 1024 * 1024 * 1024;

type CaptureFile = { pathname: string; size: number; sqlite: boolean };

async function packageBytes(installRoot: string): Promise<number> {
  const seen = new Set<string>();
  const visit = async (pathname: string): Promise<number> => {
    const entry = await statOrMissing(pathname);
    if (!entry) {
      throw new Error(`Cannot determine update package capacity; input is missing: ${pathname}`);
    }
    if (seen.has(pathname)) {
      return 0;
    }
    seen.add(pathname);
    if (seen.size > 1_000_000) {
      throw new Error(
        `Update package capacity inventory exceeds one million entries: ${installRoot}`,
      );
    }
    // Package staging preserves child symlinks; never inventory their foreign targets.
    if (entry.isFile() || entry.isSymbolicLink()) {
      return entry.size;
    }
    if (!entry.isDirectory()) {
      throw new Error(`Cannot determine update package capacity for a special file: ${pathname}`);
    }
    let bytes = 0;
    for (const name of await fs.readdir(pathname)) {
      bytes += await visit(path.join(pathname, name));
    }
    return bytes;
  };
  return await visit(await fs.realpath(installRoot));
}

/** Reserve capture/verification, rollback staging, migration growth, and package staging per volume. */
export async function assertUpdateRecoveryCapacity(params: {
  directory: string;
  installRoot: string;
  files: readonly CaptureFile[];
}): Promise<void> {
  const volumes = new Map<number, { pathname: string; required: number; available: number }>();
  const add = async (pathname: string, bytes: number) => {
    const capacity = tryReadDiskSpace(pathname);
    if (!capacity) {
      throw new Error(
        `Cannot determine update recovery capacity for ${pathname}; protected mutation refused. Live data and earlier captures are unchanged. Inspect openclaw update status --json before retrying.`,
      );
    }
    const device = (await fs.stat(capacity.checkedPath)).dev;
    const volume = volumes.get(device) ?? {
      pathname: capacity.checkedPath,
      required: RESERVE_BYTES,
      available: capacity.availableBytes,
    };
    volume.required += bytes;
    volume.available = Math.min(volume.available, capacity.availableBytes);
    if (!Number.isSafeInteger(volume.required) || !Number.isSafeInteger(volume.available)) {
      throw new Error(`Cannot safely account for update recovery capacity on ${volume.pathname}.`);
    }
    volumes.set(device, volume);
  };
  let captureBytes = MAX_MANIFEST_BYTES;
  for (const file of params.files) {
    let bytes = file.size;
    if (file.sqlite) {
      // WAL pages can grow the online snapshot beyond the main file's current size.
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
        bytes += (await statOrMissing(`${file.pathname}${suffix}`))?.size ?? 0;
      }
    }
    captureBytes += bytes;
    await add(file.pathname, bytes * 2); // One restore copy plus 100% migration growth.
  }
  await add(params.directory, captureBytes * 2); // Retained capture plus verification copy.
  await add(params.installRoot, (await packageBytes(params.installRoot)) * 2);
  for (const volume of volumes.values()) {
    if (volume.available < volume.required) {
      throw new Error(
        `Insufficient update recovery capacity on ${volume.pathname}: ${formatDiskSpaceBytes(volume.required)} required (${volume.required} bytes), ${formatDiskSpaceBytes(volume.available)} available (${volume.available} bytes), including capture, verification/restore staging, package staging, growth, and reserve. Protected mutation refused; live data and earlier captures are unchanged. Free unrelated space, then retry; inspect openclaw update status --json.`,
      );
    }
  }
}
