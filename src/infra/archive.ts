import "./fs-safe-defaults.js";
import { extractArchive as extractArchiveImpl } from "@openclaw/fs-safe/archive";
import { configureFsSafePython, getFsSafePythonConfig } from "@openclaw/fs-safe/config";

export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  ArchiveSecurityError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  createArchiveSymlinkTraversalError,
  createTarEntryPreflightChecker,
  loadZipArchiveWithPreflight,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
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
} from "@openclaw/fs-safe/archive";

type ExtractArchiveParams = Parameters<typeof extractArchiveImpl>[0];

let archiveExtractionQueue: Promise<void> = Promise.resolve();

async function withArchiveCopyFallback<T>(run: () => Promise<T>): Promise<T> {
  const previousConfig = getFsSafePythonConfig();
  if (previousConfig.mode !== "auto") {
    return await run();
  }

  // The helper's direct pinned copy can materialize archive bytes before the
  // destination hardlink guard fires. Keep the JS fallback for archive merges.
  configureFsSafePython({ mode: "off" });
  try {
    return await run();
  } finally {
    configureFsSafePython(previousConfig);
  }
}

export async function extractArchive(params: ExtractArchiveParams): Promise<void> {
  const run = archiveExtractionQueue.then(
    () => withArchiveCopyFallback(() => extractArchiveImpl(params)),
    () => withArchiveCopyFallback(() => extractArchiveImpl(params)),
  );
  archiveExtractionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
}
