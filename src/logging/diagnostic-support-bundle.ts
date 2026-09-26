// Diagnostic support bundle helpers collect logs and metadata for support exports.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";

// File builders and writers for redacted diagnostic support bundles.
export type DiagnosticSupportBundleFile = {
  path: string;
  mediaType: string;
  content: string;
};

/** Manifest entry for one written support bundle file. */
export type DiagnosticSupportBundleContent = {
  path: string;
  mediaType: string;
  bytes: number;
};

function supportBundleByteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  // SAFETY: `"code" in error` narrows `error` to carry a `code` property; its
  // runtime type is checked below before the `error is NodeJS.ErrnoException`
  // predicate is asserted.
  return typeof error.code === "string";
}

/** Creates a JSON support-bundle file with a safe relative path. */
export function jsonSupportBundleFile(
  pathName: string,
  value: unknown,
): DiagnosticSupportBundleFile {
  return {
    path: assertSafeBundleRelativePath(pathName),
    mediaType: "application/json",
    content: `${JSON.stringify(value, null, 2)}\n`,
  };
}

/** Creates an NDJSON support-bundle file with a safe relative path. */
export function jsonlSupportBundleFile(
  pathName: string,
  lines: readonly string[],
): DiagnosticSupportBundleFile {
  return {
    path: assertSafeBundleRelativePath(pathName),
    mediaType: "application/x-ndjson",
    content: `${lines.join("\n")}\n`,
  };
}

/** Creates a UTF-8 text support-bundle file with a safe relative path. */
export function textSupportBundleFile(
  pathName: string,
  content: string,
): DiagnosticSupportBundleFile {
  return {
    path: assertSafeBundleRelativePath(pathName),
    mediaType: "text/plain; charset=utf-8",
    content: content.endsWith("\n") ? content : `${content}\n`,
  };
}

/** Summarizes support-bundle files for the bundle manifest. */
export function supportBundleContents(
  files: readonly DiagnosticSupportBundleFile[],
): DiagnosticSupportBundleContent[] {
  return files.map((file) => ({
    path: file.path,
    mediaType: file.mediaType,
    bytes: supportBundleByteLength(file.content),
  }));
}

function assertSafeBundleRelativePath(pathName: string): string {
  const normalized = pathName.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid bundle file path: ${pathName}`);
  }
  return normalized;
}

function resolveSupportBundleFilePath(outputDir: string, pathName: string): string {
  const safePath = assertSafeBundleRelativePath(pathName);
  const resolvedBase = path.resolve(outputDir);
  const resolvedFile = path.resolve(resolvedBase, safePath);
  // Re-check after path.resolve so crafted relative paths cannot escape the output directory.
  if (resolvedFile === resolvedBase || !isPathInside(resolvedBase, resolvedFile)) {
    throw new Error(`Bundle file path escaped output directory: ${pathName}`);
  }
  return resolvedFile;
}

async function writeSupportBundleFile(
  outputDir: string,
  file: DiagnosticSupportBundleFile,
): Promise<void> {
  const filePath = resolveSupportBundleFilePath(outputDir, file.path);
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, file.content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

// Moves every entry of `sourceDir` into `destDir` (which must already exist
// and be empty) using same-filesystem renames. Entries are moved top-down so
// nested directories keep their relative layout. Each rename is atomic on the
// same filesystem; destDir is a private sibling staging directory, so the
// source and destination share a filesystem.
//
// The manifest entry (if present at this level) is moved last. A crash during
// publication can leave a partial destination because catch/finally does not
// run on abrupt termination; moving the manifest last guarantees the only
// reachable partial state is "payload present, manifest absent". Readers that
// gate bundle completeness on manifest presence treat such a directory as
// incomplete, so a misleading manifest-bearing partial bundle can never be
// observed. The readdir order is filesystem-dependent and does not follow the
// caller's input ordering, so this must be enforced here rather than at the
// call site.
const MANIFEST_ENTRY_NAME = "manifest.json";

async function moveDirectoryEntry(
  sourceDir: string,
  destDir: string,
  entry: fs.Dirent,
): Promise<void> {
  const sourcePath = path.join(sourceDir, entry.name);
  const destPath = path.join(destDir, entry.name);
  if (entry.isDirectory()) {
    await fsp.mkdir(destPath, { mode: 0o700 });
    await moveDirectoryEntries(sourcePath, destPath);
  } else {
    // `rename` is safe here: destDir was just claimed exclusively and is
    // private to this write, so destPath cannot already exist.
    await fsp.rename(sourcePath, destPath);
  }
}

async function moveDirectoryEntries(sourceDir: string, destDir: string): Promise<void> {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  const manifest = entries.find((entry) => entry.name === MANIFEST_ENTRY_NAME);
  for (const entry of entries) {
    if (entry === manifest) {
      continue;
    }
    await moveDirectoryEntry(sourceDir, destDir, entry);
  }
  if (manifest) {
    await moveDirectoryEntry(sourceDir, destDir, manifest);
  }
}

/** Writes support-bundle files to a new private directory. */
export async function writeSupportBundleDirectory(params: {
  outputDir: string;
  files: readonly DiagnosticSupportBundleFile[];
}): Promise<DiagnosticSupportBundleContent[]> {
  const resolvedOutputDir = path.resolve(params.outputDir);
  await fsp.mkdir(path.dirname(resolvedOutputDir), { recursive: true, mode: 0o700 });
  const stagingDir = await fsp.mkdtemp(
    path.join(path.dirname(resolvedOutputDir), `.openclaw-bundle-${randomUUID()}-`),
  );
  let claimedOutputDir = false;
  try {
    await fsp.chmod(stagingDir, 0o700);
    for (const file of params.files) {
      await writeSupportBundleFile(stagingDir, file);
    }
    // Exclusive publication: `mkdir` with the default recursive:false is an
    // atomic create-if-absent. The kernel rejects an existing path with EEXIST
    // at the operation itself, so a destination that appears between staging
    // and publication (or a genuinely pre-existing one) is refused rather than
    // silently overwritten — POSIX `rename` on a directory would otherwise
    // replace it. This preserves the no-clobber contract without a
    // check-then-act window.
    try {
      await fsp.mkdir(resolvedOutputDir, { mode: 0o700 });
    } catch (error) {
      if (isErrnoException(error) && error.code === "EEXIST") {
        throw Object.assign(
          new Error(`Bundle output directory already exists: ${resolvedOutputDir}`),
          { code: "EEXIST" },
        );
      }
      throw error;
    }
    claimedOutputDir = true;
    // Move the staged tree into the exclusively claimed destination. destDir is
    // private to this write, so each entry rename cannot collide.
    await moveDirectoryEntries(stagingDir, resolvedOutputDir);
  } catch (error) {
    // A failure after claiming the destination leaves a partial directory at
    // the final path; remove it so the target stays clean and a same-path
    // retry is not blocked by EEXIST.
    if (claimedOutputDir) {
      await fsp.rm(resolvedOutputDir, { recursive: true, force: true });
    }
    await fsp.rm(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    // The staging directory is empty once its entries have been moved out;
    // remove the now-vacant sibling. `force` keeps this no-op on the failure
    // path where it was already removed above.
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
  return supportBundleContents(params.files);
}

/** Writes support-bundle files to a private zip archive and returns the published path and byte size. */
export async function writeSupportBundleZip(params: {
  outputPath: string;
  files: readonly DiagnosticSupportBundleFile[];
  compressionLevel?: number;
}): Promise<{ path: string; bytes: number }> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of params.files) {
    zip.file(assertSafeBundleRelativePath(file.path), file.content);
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: params.compressionLevel ?? 6 },
  });
  const outputPath = path.resolve(params.outputPath);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  // Publish through the staged sibling writer: a failed or interrupted write
  // must never truncate a previously exported archive at the final path, and
  // the atomic rename also replaces an overly permissive pre-existing mode.
  const published = await writeExternalFileWithinRoot({
    rootDir: path.dirname(outputPath),
    path: path.basename(outputPath),
    fallbackFileName: "openclaw-support.zip",
    write: async (tempPath) => {
      await fsp.writeFile(tempPath, buffer, { mode: 0o600 });
    },
  });
  return { path: published.path, bytes: buffer.length };
}
