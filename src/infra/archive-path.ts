// Resolves archive paths through safe filesystem defaults.
import "./fs-safe-defaults.js";

// Archive path facade kept in infra so callers share one traversal policy.
export {
  isWindowsDrivePath,
<<<<<<< HEAD
=======
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
} from "@openclaw/fs-safe/archive";
