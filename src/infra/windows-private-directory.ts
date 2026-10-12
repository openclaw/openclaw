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
  const resolved = path.resolve(filePath);
  // fs-safe 0.26.0 stages in <parent>/.fs-safe-create-<UUID>/file. Keep short
  // publication paths plain; remove this adapter when fs-safe includes openclaw/fs-safe#924.
  const stagingLength = path.join(
    path.dirname(resolved),
    `.fs-safe-create-${"x".repeat(36)}`,
    "file",
  ).length;
  const target =
    Math.max(resolved.length, stagingLength) >= 260 ? path.toNamespacedPath(resolved) : resolved;
  return createFileSync(target, { private: true });
}
