import "./fs-safe-defaults.js";
export {
  ArchiveSecurityError,
  createArchiveSymlinkTraversalError,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  withStagedArchiveDestination,
  type ArchiveSecurityErrorCode,
} from "@openclaw/fs-safe/archive";
