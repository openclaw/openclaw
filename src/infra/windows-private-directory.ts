import path from "node:path";
import {
  createDirectorySync,
  createFileSync,
  type OwnedFileDescriptorSync,
} from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { markPrivateDirectoryCreationRefused } from "./private-directory-creation.js";

export function createPrivateWindowsDirectory(directoryPath: string): void {
  let attempted = false;
  try {
    createDirectorySync(path.toNamespacedPath(path.resolve(directoryPath)), {
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
  // fs-safe 0.26.0 also needs the prefix when its sibling staging path exceeds MAX_PATH.
  return createFileSync(path.toNamespacedPath(path.resolve(filePath)), { private: true });
}
