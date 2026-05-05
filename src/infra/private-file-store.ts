import "./fs-safe-defaults.js";
import { privateStateStore, type PrivateStateStore } from "@openclaw/fs-safe/advanced";
import {
  writePrivateJsonAtomicSync as writePrivateJsonAtomicSyncImpl,
  writePrivateTextAtomicSync as writePrivateTextAtomicSyncImpl,
} from "@openclaw/fs-safe/advanced";

export {
  readPrivateJson,
  readPrivateJsonSync,
  readPrivateText,
  readPrivateTextSync,
  writePrivateJsonAtomic,
  writePrivateJsonAtomicSync,
  writePrivateTextAtomic,
  writePrivateTextAtomicSync,
  type PrivateStateStore as PrivateFileStore,
} from "@openclaw/fs-safe/advanced";

export function privateFileStore(rootDir: string): PrivateStateStore {
  return privateStateStore({ rootDir });
}

export type PrivateFileStoreSync = {
  rootDir: string;
  path(relativePath: string): string;
  writeText(relativePath: string, content: string | Uint8Array): string;
  writeJson(relativePath: string, value: unknown, options?: { trailingNewline?: boolean }): string;
};

export function privateFileStoreSync(rootDir: string): PrivateFileStoreSync {
  const store = privateStateStore({ rootDir });
  return {
    rootDir: store.rootDir,
    path: store.path,
    writeText: (relativePath, content) => {
      const filePath = store.path(relativePath);
      writePrivateTextAtomicSyncImpl({ rootDir: store.rootDir, filePath, content });
      return filePath;
    },
    writeJson: (relativePath, value, options) => {
      const filePath = store.path(relativePath);
      writePrivateJsonAtomicSyncImpl({
        rootDir: store.rootDir,
        filePath,
        value,
        trailingNewline: options?.trailingNewline,
      });
      return filePath;
    },
  };
}
