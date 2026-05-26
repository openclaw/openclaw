import {
  fileStore,
  fileStoreSync,
  type FileStore,
  type FileStoreSync,
} from "@openclaw/fs-safe/store";
import { ensureFsSafeDefaults } from "./fs-safe-defaults.js";

export type PrivateFileStore = FileStore;

export function privateFileStore(rootDir: string): FileStore {
  ensureFsSafeDefaults();
  return fileStore({ rootDir, private: true });
}

export type PrivateFileStoreSync = FileStoreSync;

export function privateFileStoreSync(rootDir: string): PrivateFileStoreSync {
  ensureFsSafeDefaults();
  return fileStoreSync({ rootDir, private: true });
}
