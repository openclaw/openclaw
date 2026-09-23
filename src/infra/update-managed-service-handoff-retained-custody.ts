import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import { tryResolvePathCaseInsensitive } from "./path-case.js";
import type { ManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

// Match fs-safe sidecar identity without creating missing source directories.
function sourceKey(resource: string): string {
  const absolute = path.resolve(resource);
  try {
    return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return absolute;
    }
    throw error;
  }
}

function fileIdentity(file: string) {
  try {
    return fs.statSync(file, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    // Unreadable identities cannot establish that the resource is unrelated.
    throw error;
  }
}

// Observe Unicode lookup independently of case lookup, and only in the exact
// source directory. Never create a probe before custody is checked or infer a
// volume-wide default from the platform. An ASCII-only directory is unknown.
function normalizationInsensitive(directory: string): boolean | undefined {
  try {
    const names = fs.readdirSync(directory);
    for (const name of names) {
      const nfc = name.normalize("NFC");
      const nfd = name.normalize("NFD");
      if (nfc === nfd) {
        continue;
      }
      const originalPath = path.join(directory, name);
      const alternate = name === nfc ? nfd : nfc;
      const original = fs.lstatSync(originalPath, { bigint: true });
      if (original.ino === 0n) {
        return undefined;
      }
      let insensitive: boolean;
      try {
        const other = fs.lstatSync(path.join(directory, alternate), { bigint: true });
        if (other.ino === 0n) {
          return undefined;
        }
        // Two directory entries are distinct names even when hardlinked.
        insensitive =
          !names.includes(alternate) && original.dev === other.dev && original.ino === other.ino;
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        insensitive = false;
      }
      const current = fs.lstatSync(originalPath, { bigint: true });
      return current.dev === original.dev && current.ino === original.ino ? insensitive : undefined;
    }
  } catch {
    // Unreadable or changing lookup evidence cannot establish unrelatedness.
  }
  return undefined;
}

function sameSource(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  // Use actual filesystem identity, not platform-wide lowercasing. Distinct
  // files on case-sensitive volumes remain distinct. A source may not exist
  // yet: its held sidecar still identifies case/Unicode aliases at admission,
  // stale removal and release. No missing object is evidence of settlement.
  let distinct = false;
  for (const suffix of ["", ".lock"]) {
    const a = fileIdentity(left + suffix);
    const b = fileIdentity(right + suffix);
    if (a && b) {
      if (a.ino !== 0n && a.dev === b.dev && a.ino === b.ino) {
        return true;
      }
      if (a.ino !== 0n && b.ino !== 0n && (a.ino !== b.ino || a.dev !== b.dev)) {
        distinct = true;
      }
    }
  }
  if (distinct || path.dirname(left) !== path.dirname(right)) {
    return false;
  }
  const leftName = path.basename(left);
  const rightName = path.basename(right);
  const leftFolded = leftName.toLowerCase();
  const rightFolded = rightName.toLowerCase();
  if (leftFolded.normalize("NFC") !== rightFolded.normalize("NFC")) {
    return false;
  }
  if (leftFolded !== rightFolded) {
    const insensitive = normalizationInsensitive(path.dirname(right));
    if (insensitive === undefined) {
      throw new Error("Source resource Unicode alias identity is unavailable.");
    }
    if (!insensitive) {
      return false;
    }
  }
  if (leftName.normalize("NFC") === rightName.normalize("NFC")) {
    return true;
  }
  // Missing target AND sidecar must not clear a case alias. Reuse path-local
  // detection, but never create a probe before acquiring source custody.
  const insensitive = tryResolvePathCaseInsensitive(right, { allowTemporaryProbe: false });
  if (insensitive === undefined) {
    throw new Error("Source resource alias identity is unavailable.");
  }
  return insensitive;
}

/** Read-only compatibility for preserved v3 records. No current producer mints them. */
export function assertNoRetainedSourceBorrower(
  resource: string,
  rows: ManagedHandoffLeasePayload[],
) {
  // Reading/decoding every row is deliberate: unreadable prospective data
  // cannot establish that the source is unrelated. No liveness probe here.
  const key = sourceKey(resource);
  for (const lease of rows) {
    if (
      lease.version === 3 &&
      [lease.nativeBorrower.source.serviceKey, ...lease.nativeBorrower.source.configPaths].some(
        (reserved) => sameSource(reserved, key),
      )
    ) {
      throw new Error("Source resource has unresolved native custody.");
    }
  }
}
