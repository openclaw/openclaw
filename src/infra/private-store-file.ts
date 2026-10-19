import fs from "node:fs";
import path from "node:path";
import { createDirectorySync, createFileSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { applyPrivateModeSync } from "./private-mode.js";

function createPrivateIfMissing(create: () => void): void {
  try {
    create();
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "already-exists")) {
      throw error;
    }
  }
}

/** The caller admits the existing parent before preparing this store's private file. */
export function preparePrivateStoreFileSync(pathname: string, directoryExists: boolean): void {
  const directory = path.dirname(pathname);
  if (!directoryExists) {
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    createPrivateIfMissing(() => createDirectorySync(directory, { private: true }));
  }
  applyPrivateModeSync(directory, 0o700);
  if (!fs.existsSync(pathname)) {
    createPrivateIfMissing(() => createFileSync(pathname, { private: true }).close());
  }
}
