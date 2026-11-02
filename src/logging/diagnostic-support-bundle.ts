import fsp from "node:fs/promises";
import path from "node:path";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";

export type DiagnosticSupportBundleFile = ReturnType<typeof jsonSupportBundleFile>;

/** Creates a JSON support-bundle file with a safe relative path. */
export function jsonSupportBundleFile(pathName: string, value: unknown) {
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
export function supportBundleContents(files: readonly DiagnosticSupportBundleFile[]) {
  return files.map((file) => ({
    path: file.path,
    mediaType: file.mediaType,
    bytes: Buffer.byteLength(file.content, "utf8"),
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

/** Writes support-bundle files to a new private directory. */
export async function writeSupportBundleDirectory(params: {
  outputDir: string;
  files: readonly DiagnosticSupportBundleFile[];
}) {
  await fsp.mkdir(path.dirname(params.outputDir), { recursive: true, mode: 0o700 });
  await fsp.mkdir(params.outputDir, { mode: 0o700 });
  for (const file of params.files) {
    const filePath = resolveSupportBundleFilePath(params.outputDir, file.path);
    await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(filePath, file.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  return supportBundleContents(params.files);
}

/** Writes support-bundle files to a private zip archive and returns the published path and byte size. */
export async function writeSupportBundleZip(params: {
  outputPath: string;
  files: readonly DiagnosticSupportBundleFile[];
}): Promise<{ path: string; bytes: number }> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of params.files) {
    zip.file(assertSafeBundleRelativePath(file.path), file.content);
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
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
