import path from "node:path";
import {
  fileStore,
  fileStoreSync,
  type FileStore,
  type FileStoreSync,
} from "@openclaw/fs-safe/store";
import { readExistingStateRootMode, tightenPrivateDirRootSync } from "./private-dir-mode.js";

const PRIVATE_STORE_DIR_MODE = 0o700;

// fs-safe 0.8 leaves existing root modes unchanged; OpenClaw tightens its own roots.
/** Create an async private file store rooted at `rootDir`. */
export function privateFileStore(rootDir: string): FileStore {
  tightenPrivateDirRootSync(rootDir, PRIVATE_STORE_DIR_MODE);
  return fileStore({ rootDir, private: true });
}

/** Create a sync private file store rooted at `rootDir`. */
export function privateFileStoreSync(rootDir: string): FileStoreSync {
  tightenPrivateDirRootSync(rootDir, PRIVATE_STORE_DIR_MODE);
  return fileStoreSync({ rootDir, private: true });
}

/** Root-level state files stay private without treating the shared root as a private store. */
export function writePrivateTextFileAtomicSync(
  filePath: string,
  content: string,
  stateDir: string,
): void {
  const directory = path.dirname(filePath);
  const dirMode = readExistingStateRootMode(directory, stateDir);
  if (dirMode === undefined || dirMode === PRIVATE_STORE_DIR_MODE) {
    privateFileStoreSync(directory).writeText(path.basename(filePath), content);
    return;
  }
  fileStoreSync({ rootDir: directory, private: true, dirMode }).writeText(
    path.basename(filePath),
    content,
  );
}
