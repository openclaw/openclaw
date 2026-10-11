import path from "node:path";
import {
  createDirectorySync,
  createFileSync,
  type OwnedFileDescriptorSync,
} from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { markPrivateDirectoryCreationRefused } from "./private-directory-creation.js";

// fs-safe 0.26.0 hands plain spellings to Win32, which refuses paths past the
// 248-character directory limit; openclaw/fs-safe#924 fixes this upstream.
// Drop this once the pinned fs-safe release includes it.
function win32Spelling(target: string): string {
  const resolved = path.resolve(target);
  return resolved.length < 248 ? resolved : path.toNamespacedPath(resolved);
}

export function createPrivateWindowsDirectory(directoryPath: string): void {
  let attempted = false;
  try {
    createDirectorySync(win32Spelling(directoryPath), {
      private: true,
      assertBeforeMutation() {
        attempted = true;
      },
    });
  } catch (error) {
    // A dispatched create may fail after publication or during cleanup. Only
    // preflight failures and exclusive-create collisions prove no new directory.
    if (!attempted || (error instanceof FsSafeError && error.code === "already-exists")) {
      throw markPrivateDirectoryCreationRefused(error);
    }
    throw error;
  }
}

export function createPrivateWindowsFile(filePath: string): OwnedFileDescriptorSync {
  return createFileSync(win32Spelling(filePath), { private: true });
}
