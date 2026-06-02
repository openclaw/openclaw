import fsp from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";

export type DiagnosticSupportBundleFile = {
  /** Safe relative path inside the support bundle. */
  path: string;
  /** MIME type recorded in the bundle manifest. */
  mediaType: string;
  /** UTF-8 text payload written into the bundle. */
  content: string;
};

export type DiagnosticSupportBundleContent = {
  /** Bundle-relative file path. */
  path: string;
  /** MIME type copied from the file descriptor. */
  mediaType: string;
  /** UTF-8 byte length of the stored content. */
  bytes: number;
};

function supportBundleByteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

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
  // Bundle paths are portable archive entries, never filesystem paths. Reject
  // absolute, empty, dot, and parent segments before any write or zip insert.
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid bundle file path: ${pathName}`);
  }
  return normalized;
}

async function prepareSupportBundleDirectory(outputDir: string): Promise<void> {
  await fsp.mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await fsp.mkdir(outputDir, { mode: 0o700 });
}

function resolveSupportBundleFilePath(outputDir: string, pathName: string): string {
  const safePath = assertSafeBundleRelativePath(pathName);
  const resolvedBase = path.resolve(outputDir);
  const resolvedFile = path.resolve(resolvedBase, safePath);
  // Re-check containment after path.resolve so crafted relative paths cannot
  // escape the output directory even if validation changes later.
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

export async function writeSupportBundleDirectory(params: {
  /** Directory to create and fill with support bundle files. */
  outputDir: string;
  /** Files to write; existing files cause the write to fail. */
  files: readonly DiagnosticSupportBundleFile[];
}): Promise<DiagnosticSupportBundleContent[]> {
  await prepareSupportBundleDirectory(params.outputDir);
  for (const file of params.files) {
    await writeSupportBundleFile(params.outputDir, file);
  }
  return supportBundleContents(params.files);
}

export async function writeSupportBundleZip(params: {
  /** Zip file path to create or replace. */
  outputPath: string;
  /** Files to store using safe bundle-relative paths. */
  files: readonly DiagnosticSupportBundleFile[];
  /** DEFLATE compression level, defaulting to a balanced level. */
  compressionLevel?: number;
}): Promise<number> {
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
  await fsp.mkdir(path.dirname(params.outputPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(params.outputPath, buffer, { mode: 0o600 });
  return buffer.length;
}
