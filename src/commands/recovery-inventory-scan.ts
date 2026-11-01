import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { hasErrnoCode } from "../infra/errno.js";

/** Diagnostic work allowance only: never retention policy or deletion authority. */
export class RecoveryInventoryScan {
  readonly reasons = new Set<string>();
  private entries = 0;
  private metadataBytes = 0;
  private readonly startedAt = performance.now();

  private readonly limits = { entries: 2_000, metadataBytes: 2 * 1024 * 1024, timeMs: 150 };

  get incomplete() {
    return this.reasons.size > 0;
  }

  available(): boolean {
    if (performance.now() - this.startedAt >= this.limits.timeMs) {
      this.reasons.add("time-limit");
      return false;
    }
    if (this.entries >= this.limits.entries) {
      this.reasons.add("entry-limit");
      return false;
    }
    return true;
  }

  *directory(directory: string): Generator<fs.Dirent> {
    if (!this.available()) {
      return;
    }
    let opened: fs.Dir | undefined;
    try {
      opened = fs.opendirSync(directory);
      while (this.available()) {
        const entry = opened.readSync();
        if (!entry) {
          break;
        }
        this.entries++;
        yield entry;
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        this.reasons.add("unreadable-directory");
      }
    } finally {
      opened?.closeSync();
    }
  }

  metadata(file: string): boolean {
    if (!this.available()) {
      return false;
    }
    try {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) {
        return true;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        this.reasons.add("metadata-alias-or-nonregular");
        return false;
      }
      if (this.metadataBytes + stat.size > this.limits.metadataBytes) {
        this.reasons.add("metadata-byte-limit");
        return false;
      }
      this.metadataBytes += stat.size;
      return true;
    } catch {
      this.reasons.add("unreadable-metadata");
      return false;
    }
  }

  logicalBytes(directory: string): number {
    let bytes = 0;
    // Iterative walk also bounds stack use for unexpectedly deep capture trees.
    const pending = [directory];
    while (pending.length && this.available()) {
      for (const entry of this.directory(pending.pop()!)) {
        const file = path.join(entry.parentPath, entry.name);
        if (entry.isDirectory()) {
          pending.push(file);
        } else if (entry.isFile()) {
          try {
            bytes += fs.lstatSync(file).size;
          } catch {
            this.reasons.add("unreadable-file");
          }
        } else {
          this.reasons.add("artifact-alias-or-nonregular");
        }
      }
    }
    return bytes;
  }
}
