// Exposes root-scoped file open helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Root-scoped file open helpers. Use these for user paths that must stay under
// an already trusted boundary.
export {
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  openRootFile,
  openRootFileSync,
<<<<<<< HEAD
  type RootFileOpenFailure,
=======
  type OpenRootFileParams,
  type OpenRootFileSyncParams,
  type RootFileOpenFailure,
  type RootFileOpenFailureReason,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  type RootFileOpenResult,
} from "@openclaw/fs-safe/advanced";
