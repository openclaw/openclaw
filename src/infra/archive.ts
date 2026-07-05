// Exposes archive extraction helpers after applying fs-safe defaults.
import "./fs-safe-defaults.js";

// Archive extraction facade for size limits, staged writes, and traversal checks.
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  ArchiveSecurityError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
<<<<<<< HEAD
=======
  createArchiveSymlinkTraversalError,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  createTarEntryPreflightChecker,
  extractArchive,
  loadZipArchiveWithPreflight,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
<<<<<<< HEAD
  resolveArchiveKind,
  resolvePackedRootDir,
  withStagedArchiveDestination,
  type ArchiveLogger,
=======
  prepareArchiveOutputPath,
  readZipCentralDirectoryEntryCount,
  resolveArchiveKind,
  resolvePackedRootDir,
  withStagedArchiveDestination,
  type ArchiveExtractLimits,
  type ArchiveKind,
  type ArchiveLimitErrorCode,
  type ArchiveLogger,
  type ArchiveSecurityErrorCode,
  type TarEntryInfo,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
} from "@openclaw/fs-safe/archive";
