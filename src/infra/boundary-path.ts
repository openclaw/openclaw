// Exposes boundary path resolution helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Boundary path resolution keeps alias expansion and realpath checks in one
// shared contract before file IO happens.
export {
<<<<<<< HEAD
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
=======
  ROOT_PATH_ALIAS_POLICIES,
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
  type RootPathAliasPolicy,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
} from "@openclaw/fs-safe/advanced";
