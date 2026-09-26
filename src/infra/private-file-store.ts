import {
  fileStore,
  fileStoreSync,
  type FileStore,
  type FileStoreSync,
} from "@openclaw/fs-safe/store";
import { tightenPrivateDirRootSync } from "./private-dir-mode.js";

const PRIVATE_STORE_DIR_MODE = 0o700;

// fs-safe 0.8 leaves existing root modes unchanged; OpenClaw tightens its own roots.
/** Create an async private file store rooted at `rootDir`. */
export function privateFileStore(rootDir: string): FileStore {
  tightenPrivateDirRootSync(rootDir, PRIVATE_STORE_DIR_MODE);
  return fileStore({ rootDir, private: true });
}

type PrivateFileStoreSync = FileStoreSync;

/** Create a sync private file store rooted at `rootDir`. */
export function privateFileStoreSync(rootDir: string): PrivateFileStoreSync {
  tightenPrivateDirRootSync(rootDir, PRIVATE_STORE_DIR_MODE);
  return fileStoreSync({ rootDir, private: true });
}
