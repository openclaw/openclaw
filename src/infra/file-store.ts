// Exposes fs-safe file stores after applying OpenClaw filesystem defaults.
import "./fs-safe-defaults.js";

// Safe file-store facade. Callers get the repo default fs-safe configuration
// before constructing root-scoped stores.
<<<<<<< HEAD
export { fileStore, type FileStore } from "@openclaw/fs-safe/store";
=======
export {
  fileStore,
  type FileStore,
  type FileStoreOptions,
  type FileStorePruneOptions,
  type FileStoreWriteOptions,
} from "@openclaw/fs-safe/store";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
