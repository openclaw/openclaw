// Exposes archive extraction helpers after applying fs-safe defaults.
import "./fs-safe-defaults.js";
import {
  extractArchive as extractArchiveWithFsSafe,
  type ExtractArchiveOptions,
} from "@openclaw/fs-safe/archive";

// Archive extraction facade for size limits, staged writes, and traversal checks.
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveFormatError,
  ArchiveLimitError,
  ArchiveSecurityError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  createTarEntryPreflightChecker,
  inspectTarArchive,
  loadZipArchiveWithPreflight,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  readArchiveEntry,
  resolveArchiveKind,
  resolvePackedRootDir,
  withStagedArchiveDestination,
  type ArchiveLogger,
  type ArchiveEntryKind,
  type ArchiveExtractLimits,
  type ExtractArchiveOptions,
} from "@openclaw/fs-safe/archive";

/** Retain OpenClaw's durable publication default; disposable extraction opts out explicitly. */
export async function extractArchive(params: ExtractArchiveOptions): Promise<void> {
  // Read declared fields so inherited options and class getters survive this adapter.
  return await extractArchiveWithFsSafe({
    archivePath: params.archivePath,
    destDir: params.destDir,
    timeoutMs: params.timeoutMs,
    durable: params.durable ?? true,
    kind: params.kind,
    stripComponents: params.stripComponents,
    tarGzip: params.tarGzip,
    limits: params.limits,
    logger: params.logger,
    entryModes: params.entryModes,
    entryFilter: params.entryFilter,
    onFiltered: params.onFiltered,
  });
}
