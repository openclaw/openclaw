import fs from "node:fs";
import path from "node:path";
import { createDirectorySync, createFileSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { applyPrivateModeSync } from "./private-mode.js";

function createPrivateIfMissing(create: () => void): boolean {
  try {
    create();
    return true;
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "already-exists")) {
      throw error;
    }
    return false;
  }
}

/** The caller admits the existing parent before preparing this store's private file. */
export function preparePrivateStoreFileSync(pathname: string, directoryExists: boolean): boolean {
  const directory = path.dirname(pathname);
  if (!directoryExists) {
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  }
  // State roots may be aliases; private children must still be real directories.
  const creationDirectory = path.join(
    fs.realpathSync.native(path.dirname(directory)),
    path.basename(directory),
  );
  if (!directoryExists) {
    createPrivateIfMissing(() => createDirectorySync(creationDirectory, { private: true }));
  }
  applyPrivateModeSync(directory, 0o700);
  if (!fs.existsSync(pathname)) {
    return createPrivateIfMissing(() =>
      createFileSync(path.join(creationDirectory, path.basename(pathname)), {
        private: true,
      }).close(),
    );
  }
  return false;
}
