// Exposes lifecycle-owned file lock managers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Process-local file lock manager used by code that needs explicit lifecycle
// control instead of a one-shot withFileLock call.
<<<<<<< HEAD
export { createFileLockManager } from "@openclaw/fs-safe/file-lock";
=======
export {
  createFileLockManager,
  type FileLockHeldEntry,
  type FileLockManager,
} from "@openclaw/fs-safe/file-lock";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
