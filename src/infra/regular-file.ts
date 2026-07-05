// Exposes regular-file IO helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Regular-file IO helpers reject symlinks and non-file targets before reads or
// appends touch user-controlled paths.
export {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
  statRegularFileSync,
<<<<<<< HEAD
=======
  type AppendRegularFileOptions,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  type RegularFileStatResult,
} from "@openclaw/fs-safe/advanced";
