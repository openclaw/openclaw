import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  ArchiveSecurityError,
  DEFAULT_MAX_ENTRY_BYTES,
  type ArchiveEntryKind,
} from "../infra/archive.js";
import { sha256File } from "../infra/directory-durability.js";
import { formatErrorMessage } from "../infra/errors.js";
import { root } from "../infra/fs-safe.js";
import {
  buildClawHubInstallFailure,
  CLAWHUB_INSTALL_ERROR_CODE,
  type ClawHubInstallFailure,
} from "./clawhub-error-codes.js";

export type ClawHubFileVerificationEntry = {
  path: string;
  sha256: string;
};

export const CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE = "_meta.json";

function validateClawHubArchiveMetaJson(params: {
  packageName: string;
  version: string;
  bytes: Buffer;
}): ClawHubInstallFailure | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.bytes.toString("utf8"));
  } catch {
    return buildClawHubInstallFailure(
      `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.version}": _meta.json is not valid JSON.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    return buildClawHubInstallFailure(
      `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.version}": _meta.json is not a JSON object.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  const record = parsed as { slug?: unknown; version?: unknown }; // SAFETY: The object guard above establishes a record; fields remain unknown and are compared directly.
  if (record.slug !== params.packageName) {
    return buildClawHubInstallFailure(
      `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.version}": _meta.json slug does not match the package name.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  if (record.version !== params.version) {
    return buildClawHubInstallFailure(
      `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.version}": _meta.json version does not match the package version.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  return null;
}

export function mapClawHubArchiveReadFailure(error: unknown): ClawHubInstallFailure {
  let message =
    "ClawHub archive fallback verification failed while reading the downloaded archive.";
  if (error instanceof ArchiveLimitError) {
    const messages: Partial<Record<ArchiveLimitError["code"], string>> = {
      [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT]:
        "ClawHub archive fallback verification exceeded the archive entry limit.",
      [ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT]:
        "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
      [ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT]:
        "ClawHub archive fallback verification exceeded the total extracted-size limit.",
      [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT]:
        "ClawHub archive fallback verification exceeded the per-file size limit.",
    };
    message = messages[error.code] ?? message;
  } else if (error instanceof ArchiveSecurityError) {
    message = `ClawHub archive fallback verification rejected the downloaded archive: ${formatErrorMessage(error)}`;
  }
  return buildClawHubInstallFailure(message, CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH);
}

export async function verifyClawHubExtractedFiles(params: {
  extractDir: string;
  archiveEntries: ReadonlyMap<string, ArchiveEntryKind>;
  packageName: string;
  packageVersion: string;
  files: ClawHubFileVerificationEntry[];
}): Promise<{ ok: true; validatedGeneratedPaths: string[] } | ClawHubInstallFailure> {
  try {
    const extracted = await root(params.extractDir);
    const actualFiles = new Map<string, string | undefined>();
    const validatedGeneratedPaths: string[] = [];
    // Successful extraction into the fresh workspace publishes only observed files.
    for (const [relativePath, kind] of params.archiveEntries) {
      // Unsupported named records remain digest-less even when extraction omits them.
      actualFiles.set(relativePath, undefined);
      if (kind !== "file") {
        continue;
      }
      if (relativePath === CLAWHUB_GENERATED_ARCHIVE_METADATA_FILE) {
        const metaFailure = validateClawHubArchiveMetaJson({
          packageName: params.packageName,
          version: params.packageVersion,
          bytes: await extracted.readBytes(relativePath, { maxBytes: DEFAULT_MAX_ENTRY_BYTES }),
        });
        if (metaFailure) {
          return metaFailure;
        }
        validatedGeneratedPaths.push(relativePath);
        actualFiles.delete(relativePath);
        continue;
      }
      // Archive names are literal; Root expands unprefixed ~/ inputs.
      await using opened = await extracted.open(`./${relativePath}`);
      const { digest } = await sha256File(opened.handle, { maxBytes: DEFAULT_MAX_ENTRY_BYTES });
      actualFiles.set(relativePath, digest);
    }
    for (const file of params.files) {
      const actualSha256 = actualFiles.get(file.path);
      if (!actualSha256) {
        return buildClawHubInstallFailure(
          `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.packageVersion}": missing "${file.path}".`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      if (actualSha256 !== file.sha256) {
        return buildClawHubInstallFailure(
          `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.packageVersion}": expected ${file.path} to hash to ${file.sha256}, got ${actualSha256}.`,
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        );
      }
      actualFiles.delete(file.path);
    }
    let unexpectedFile: string | undefined;
    for (const file of actualFiles.keys()) {
      if (unexpectedFile === undefined || file < unexpectedFile) {
        unexpectedFile = file;
      }
    }
    if (unexpectedFile) {
      return buildClawHubInstallFailure(
        `ClawHub archive contents do not match files[] metadata for "${params.packageName}@${params.packageVersion}": unexpected file "${unexpectedFile}".`,
        CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      );
    }
    return {
      ok: true,
      validatedGeneratedPaths,
    };
  } catch (error) {
    return mapClawHubArchiveReadFailure(error);
  }
}
