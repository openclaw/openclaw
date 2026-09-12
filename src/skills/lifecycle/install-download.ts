// Install download helpers fetch remote skill artifacts into temporary storage.
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isWindowsDrivePath } from "../../infra/archive-path.js";
import { sha256File } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { FsSafeError, root as fsRoot, type Root } from "../../infra/fs-safe.js";
import { assertCanonicalPathWithinBase } from "../../infra/install-safe-path.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { isWithinDir } from "../../infra/path-safety.js";
import { withTempDownloadPath } from "../../infra/temp-download.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { ensureDir, resolveUserPath } from "../../utils.js";
import { resolveSkillToolsRootDir } from "../runtime/tools-dir.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";
import { formatInstallFailureMessage } from "./install-output.js";
import type { SkillInstallResult } from "./install-types.js";

const extractModuleLoader = createLazyImportLoader(() => import("./install-extract.js"));
// Skill downloads share ClawHub and marketplace's 256 MiB artifact ceiling;
// changing this limit is a supported-artifact compatibility decision.
const MAX_SKILL_DOWNLOAD_BYTES = 256 * 1024 * 1024;

async function loadExtractModule() {
  return await extractModuleLoader.load();
}

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

async function cancelIgnoredResponseBody(response: Response): Promise<void> {
  const body = response.body as unknown;
  const cancel =
    body && typeof (body as { cancel?: unknown }).cancel === "function"
      ? (body as { cancel: () => Promise<void> | void }).cancel
      : undefined;
  if (!cancel) {
    return;
  }
  await Promise.resolve(cancel.call(body)).catch(() => undefined);
}

function resolveDownloadTargetDir(entry: SkillEntry, spec: SkillInstallSpec): string {
  const root = resolveSkillToolsRootDir(entry);
  const raw = spec.targetDir?.trim();
  if (!raw) {
    return root;
  }

  // Treat non-absolute paths as relative to the per-skill tools root.
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw)
      ? resolveUserPath(raw)
      : path.resolve(root, raw);

  if (!isWithinDir(root, resolved)) {
    throw new Error(
      `Refusing to install outside the skill tools directory. targetDir="${raw}" resolves to "${resolved}". Allowed root: "${root}".`,
    );
  }
  return resolved;
}

function isWellFormedLanguageTag(value: string): boolean {
  if (!value) {
    return true;
  }
  const tag = value.toLowerCase();
  // RFC 5646 includes private-use and grandfathered forms that Intl.Locale rejects.
  if (
    /^(?:x(?:-[a-z0-9]{1,8})+|en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)|sgn-(?:be-fr|be-nl|ch-de))$/u.test(
      tag,
    )
  ) {
    return true;
  }
  if (
    !/^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$/u.test(
      tag,
    )
  ) {
    return false;
  }
  const subtags = tag.split("-");
  const privateUse = subtags.indexOf("x");
  const publicSubtags = privateUse < 0 ? subtags : subtags.slice(0, privateUse);
  const extension = publicSubtags.findIndex((subtag) => subtag.length === 1);
  const variants = publicSubtags
    .slice(1, extension < 0 ? publicSubtags.length : extension)
    .filter((subtag) => subtag.length >= 5 || /^[0-9][a-z0-9]{3}$/u.test(subtag));
  const singletons = publicSubtags.filter((subtag) => subtag.length === 1);
  return (
    new Set(variants).size === variants.length && new Set(singletons).size === singletons.length
  );
}

function archiveTypeFromContentDisposition(header: string | null): string | undefined {
  if (!header || /\p{Cc}/u.test(header.replaceAll("\t", ""))) {
    return undefined;
  }
  const disposition = /^[\t ]*[!#$%&'*+.^_`|~0-9A-Za-z-]+[\t ]*/u.exec(header);
  if (!disposition) {
    return undefined;
  }
  const parameter =
    /;[\t ]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)[\t ]*=[\t ]*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))[\t ]*(?=;|$)/uy;
  const values = new Map<string, string>();
  let offset = disposition[0].length;
  // Validate the whole header before selecting a filename; later duplicates and
  // unfinished quotes must leave the URL fallback available.
  while (offset < header.length) {
    parameter.lastIndex = offset;
    const match = parameter.exec(header);
    if (!match) {
      return undefined;
    }
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3];
    if (
      !name ||
      value === undefined ||
      values.has(name) ||
      (name === "filename*" && match[2] !== undefined)
    ) {
      return undefined;
    }
    values.set(name, value.replace(/\\(.)/gu, "$1"));
    offset = parameter.lastIndex;
  }
  let filename = values.get("filename");
  const extended = values.get("filename*");
  const extendedValue =
    extended && /^utf-8'([^']*)'((?:[a-z0-9!#$&+.^_`|~-]|%[0-9a-f]{2})*)$/iu.exec(extended);
  const language = extendedValue?.[1];
  const encoded = extendedValue?.[2];
  if (language !== undefined && encoded !== undefined && isWellFormedLanguageTag(language)) {
    try {
      const decoded = decodeURIComponent(encoded);
      if (!/\p{Cc}/u.test(decoded)) {
        filename = decoded;
      }
    } catch {
      // Invalid extended values leave the ordinary filename available.
    }
  }
  return filename && !/\p{Cc}/u.test(filename) ? detectArchiveType(filename) : undefined;
}

function detectArchiveType(filename: string | undefined): string | undefined {
  const lower = normalizeOptionalLowercaseString(filename);
  if (!lower) {
    return undefined;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) {
    return "tar.bz2";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
}

function resolveArchiveType(
  spec: SkillInstallSpec,
  filename: string,
  responseArchiveType?: string,
): string | undefined {
  const explicit = normalizeOptionalLowercaseString(spec.archive);
  if (explicit) {
    return explicit;
  }
  return responseArchiveType ?? detectArchiveType(filename);
}

async function downloadFile(params: {
  url: string;
  relativePath: string;
  pinnedRoot: Root;
  tempPath: string;
  sha256?: string;
  timeoutMs: number;
}): Promise<{ bytes: number; responseArchiveType: string | undefined }> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    timeoutMs: Math.max(1_000, params.timeoutMs),
  });
  try {
    if (!response.ok || !response.body) {
      await cancelIgnoredResponseBody(response);
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    const responseArchiveType = archiveTypeFromContentDisposition(
      response.headers.get("content-disposition"),
    );
    // Encoded Content-Length measures wire bytes, not the decoded stream we cap.
    const contentEncoding = normalizeOptionalLowercaseString(
      response.headers.get("content-encoding"),
    );
    const declaredBytes =
      !contentEncoding || contentEncoding === "identity"
        ? parseStrictNonNegativeInteger(response.headers.get("content-length"))
        : undefined;
    if (declaredBytes !== undefined && declaredBytes > MAX_SKILL_DOWNLOAD_BYTES) {
      await cancelIgnoredResponseBody(response);
      throw new Error(
        `Skill download exceeds ${MAX_SKILL_DOWNLOAD_BYTES}-byte limit (declared ${declaredBytes} bytes)`,
      );
    }
    const file = fs.createWriteStream(params.tempPath);
    const body = response.body as unknown;
    const readable = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    let downloadedBytes = 0;
    const limitedBody = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes +=
          typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
        if (downloadedBytes > MAX_SKILL_DOWNLOAD_BYTES) {
          callback(new Error(`Skill download exceeds ${MAX_SKILL_DOWNLOAD_BYTES}-byte limit`));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(readable, limitedBody, file);
    if (params.sha256) {
      const actual = await sha256File(params.tempPath);
      if (actual !== params.sha256) {
        const filename = path.basename(params.relativePath);
        throw new Error(
          `SHA-256 mismatch for ${filename}: expected ${params.sha256}, actual ${actual}. The download was discarded; verify the publisher checksum or update the skill manifest before retrying.`,
        );
      }
    }
    await params.pinnedRoot.copyIn(params.relativePath, params.tempPath);
    return { bytes: file.bytesWritten, responseArchiveType };
  } finally {
    await release();
  }
}

async function publishExtractedTree(params: {
  sourceDir: string;
  targetRelativePath: string;
  pinnedRoot: Root;
}): Promise<void> {
  if (params.targetRelativePath) {
    await params.pinnedRoot.mkdir(params.targetRelativePath);
  } else {
    await params.pinnedRoot.ensureRoot();
  }

  const publishDirectory = async (relativeDir: string): Promise<void> => {
    const sourceDir = path.join(params.sourceDir, relativeDir);
    for (const entry of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
      const relativePath = path.join(relativeDir, entry.name);
      const sourcePath = path.join(params.sourceDir, relativePath);
      const destinationPath = path.join(params.targetRelativePath, relativePath);
      const sourceStat = await fs.promises.lstat(sourcePath);
      try {
        if (sourceStat.isDirectory()) {
          await params.pinnedRoot.mkdir(destinationPath);
          await publishDirectory(relativePath);
          continue;
        }
        if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
          throw new Error(`archive staging contains unsupported entry: ${relativePath}`);
        }
        await params.pinnedRoot.copyIn(destinationPath, sourcePath, {
          mode: sourceStat.mode & 0o777,
          sourceHardlinks: "reject",
        });
      } catch (error) {
        if (
          error instanceof FsSafeError &&
          (error.code === "symlink" || error.code === "path-alias")
        ) {
          throw new Error(`archive entry traverses symlink in destination: ${relativePath}`, {
            cause: error,
          });
        }
        throw error;
      }
    }
  };
  await publishDirectory("");
}

export async function installDownloadSpec(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { entry, spec, timeoutMs } = params;
  const root = resolveSkillToolsRootDir(entry);
  const url = spec.url?.trim();
  if (!url) {
    return {
      ok: false,
      message: "missing download url",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  let filename;
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) {
    filename = "download";
  }

  let canonicalRoot;
  let targetDir;
  let pinnedRoot: Root;
  try {
    await ensureDir(root);
    await assertCanonicalPathWithinBase({
      baseDir: root,
      candidatePath: root,
      boundaryLabel: "skill tools directory",
    });
    canonicalRoot = await fs.promises.realpath(root);
    // Bind root identity before fetching so a concurrent replacement cannot redirect publication.
    pinnedRoot = await fsRoot(canonicalRoot);

    const requestedTargetDir = resolveDownloadTargetDir(entry, spec);
    const targetRelativePath = path.relative(root, requestedTargetDir);
    targetDir = path.join(canonicalRoot, targetRelativePath);
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archivePath = path.join(targetDir, filename);
  const archiveRelativePath = path.relative(canonicalRoot, archivePath);
  if (
    !archiveRelativePath ||
    archiveRelativePath === ".." ||
    archiveRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(archiveRelativePath)
  ) {
    return {
      ok: false,
      message: "invalid download archive path",
      stdout: "",
      stderr: "invalid download archive path",
      code: null,
    };
  }
  return await withTempDownloadPath({ prefix: "skill-download" }, async (tempArchivePath) => {
    let downloaded;
    let responseArchiveType: string | undefined;
    try {
      const result = await downloadFile({
        url,
        relativePath: archiveRelativePath,
        pinnedRoot,
        tempPath: tempArchivePath,
        sha256: spec.sha256,
        timeoutMs,
      });
      downloaded = result.bytes;
      responseArchiveType = result.responseArchiveType;
    } catch (err) {
      const message = formatErrorMessage(err);
      return { ok: false, message, stdout: "", stderr: message, code: null };
    }

    const archiveType = resolveArchiveType(spec, filename, responseArchiveType);
    const shouldExtract = spec.extract ?? Boolean(archiveType);
    if (!shouldExtract) {
      return {
        ok: true,
        message: `Downloaded to ${archivePath}`,
        stdout: `downloaded=${downloaded}`,
        stderr: "",
        code: 0,
      };
    }

    if (!archiveType) {
      return {
        ok: false,
        message: "extract requested but archive type could not be detected",
        stdout: "",
        stderr: "",
        code: null,
      };
    }

    const stagingDir = path.join(path.dirname(tempArchivePath), "extracted");
    try {
      await fs.promises.mkdir(stagingDir, { mode: 0o700 });
      const { extractArchive } = await loadExtractModule();
      const extractResult = await extractArchive({
        archivePath: tempArchivePath,
        archiveType,
        targetDir: stagingDir,
        stripComponents: spec.stripComponents,
        timeoutMs,
      });
      if (extractResult.code === 0) {
        // Extraction never reopens the published archive or trusts its mutable destination path.
        await publishExtractedTree({
          sourceDir: stagingDir,
          targetRelativePath: path.relative(canonicalRoot, targetDir),
          pinnedRoot,
        });
      }
      const success = extractResult.code === 0;
      return {
        ok: success,
        message: success
          ? `Downloaded and extracted to ${targetDir}`
          : formatInstallFailureMessage(extractResult),
        stdout: extractResult.stdout.trim(),
        stderr: extractResult.stderr.trim(),
        code: extractResult.code,
      };
    } catch (err) {
      const message = formatErrorMessage(err);
      return { ok: false, message, stdout: "", stderr: message, code: 1 };
    }
  });
}
