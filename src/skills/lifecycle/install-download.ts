import fs from "node:fs";
import path from "node:path";
import { isWindowsDrivePath } from "@openclaw/fs-safe/archive";
import { isWithinDir } from "@openclaw/fs-safe/path";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sha256File } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { FsSafeError, root as fsRoot, type Root } from "../../infra/fs-safe.js";
import { assertCanonicalPathWithinBase } from "../../infra/install-safe-path.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { withTempDownloadPath } from "../../infra/temp-download.js";
import { ensureDir, resolveUserPath } from "../../utils.js";
import { resolveSkillToolsRootDir } from "../runtime/tools-dir.js";
import type { SkillInstallSpec } from "../types.js";
import { formatInstallFailureMessage } from "./install-output.js";
import type { SkillInstallResult } from "./install-types.js";

// Skill downloads share ClawHub and marketplace's 256 MiB artifact ceiling;
// changing this limit is a supported-artifact compatibility decision.
const MAX_SKILL_DOWNLOAD_BYTES = 256 * 1024 * 1024;

function resolveDownloadTargetDir(skillKey: string, spec: SkillInstallSpec): string {
  const root = resolveSkillToolsRootDir(skillKey);
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

function parseSkillInstallFileName(header: string | null): string | undefined {
  const disposition = /^[\t ]*[!#$%&'*+.^_`|~\da-z-]+[\t ]*/i.exec(header ?? "");
  if (!header || !disposition) {
    return undefined;
  }
  const parameter =
    /;[\t ]*([!#$%&'*+.^_`|~\da-z-]+)[\t ]*=[\t ]*(?:"((?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*)"|([!#$%&'*+.^_`|~\da-z-]+))[\t ]*/giy;
  let filename: string | undefined;
  let extended: string | undefined;
  let offset = disposition[0].length;
  while (offset < header.length) {
    parameter.lastIndex = offset;
    const match = parameter.exec(header);
    if (!match) {
      return undefined;
    }
    offset = parameter.lastIndex;
    const name = match[1]!.toLowerCase();
    if (name === "filename") {
      if (filename !== undefined) {
        return undefined;
      }
      filename = match[2]?.replace(/\\([\s\S])/g, "$1") ?? match[3]!;
    } else if (name === "filename*") {
      if (extended !== undefined || match[2] !== undefined) {
        return undefined;
      }
      const value =
        /^utf-8'(?:[a-z]{1,8}(?:-[a-z\d]{1,8})*)?'((?:[!#$&+.^_`|~\da-z-]|%[\da-f]{2})*)$/i.exec(
          match[3]!,
        );
      if (!value) {
        return undefined;
      }
      try {
        extended = decodeURIComponent(value[1]!);
      } catch {
        return undefined;
      }
    }
  }
  // An empty extended filename still overrides filename; the caller then uses the URL.
  return (extended ?? filename) || undefined;
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

function downloadFailure(
  message: string,
  details: { stderr?: string; code?: number } = {},
): SkillInstallResult {
  return {
    ok: false,
    message,
    stdout: "",
    stderr: details.stderr ?? message,
    code: details.code ?? null,
  };
}

export async function installDownloadSpec(params: {
  skillKey: string;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { skillKey, spec, timeoutMs } = params;
  const root = resolveSkillToolsRootDir(skillKey);
  const url = spec.url?.trim();
  if (!url) {
    return downloadFailure("missing download url", { stderr: "" });
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

    const requestedTargetDir = resolveDownloadTargetDir(skillKey, spec);
    const targetRelativePath = path.relative(root, requestedTargetDir);
    targetDir = path.join(canonicalRoot, targetRelativePath);
  } catch (err) {
    return downloadFailure(formatErrorMessage(err));
  }

  const archivePath = path.join(targetDir, filename);
  const archiveRelativePath = path.relative(canonicalRoot, archivePath);
  if (
    !archiveRelativePath ||
    archiveRelativePath === ".." ||
    archiveRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(archiveRelativePath)
  ) {
    return downloadFailure("invalid download archive path");
  }
  return await withTempDownloadPath({ prefix: "skill-download" }, async (tempArchivePath) => {
    let downloaded;
    let archiveFileName: string | undefined;
    try {
      const result = await (async (): Promise<{ bytes: number; archiveFileName?: string }> => {
        const sha256 = spec.sha256;
        const temporaryRoot = await fsRoot(path.dirname(tempArchivePath));
        const { response, release } = await fetchWithSsrFGuard({
          url,
          timeoutMs: Math.max(1_000, timeoutMs),
        });
        try {
          if (!response.ok || !response.body) {
            throw new Error(`Download failed (${response.status} ${response.statusText})`);
          }
          const downloadFileName = parseSkillInstallFileName(
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
            throw new Error(
              `Skill download exceeds ${MAX_SKILL_DOWNLOAD_BYTES}-byte limit (declared ${declaredBytes} bytes)`,
            );
          }
          const body = response.body;
          let downloadedBytes = 0;
          async function* chunks() {
            // Delay reader acquisition until path admission; the fetch guard owns cancellation.
            for await (const chunk of body.values({ preventCancel: true })) {
              downloadedBytes += chunk.byteLength;
              yield chunk;
            }
          }
          await temporaryRoot.create(path.basename(tempArchivePath), chunks(), {
            maxBytes: MAX_SKILL_DOWNLOAD_BYTES,
            mkdir: false,
            durable: false,
            mode: 0o666 & ~process.umask(),
          });
          if (sha256) {
            const actual = await sha256File(tempArchivePath);
            if (actual !== sha256) {
              const checksumFileName = path.basename(archiveRelativePath);
              throw new Error(
                `SHA-256 mismatch for ${checksumFileName}: expected ${sha256}, actual ${actual}. The download was discarded; verify the publisher checksum or update the skill manifest before retrying.`,
              );
            }
          }
          await pinnedRoot.copyIn(archiveRelativePath, tempArchivePath);
          return downloadFileName
            ? { bytes: downloadedBytes, archiveFileName: downloadFileName }
            : { bytes: downloadedBytes };
        } catch (error) {
          if (error instanceof FsSafeError && error.code === "too-large") {
            throw new Error(`Skill download exceeds ${MAX_SKILL_DOWNLOAD_BYTES}-byte limit`, {
              cause: error,
            });
          }
          throw error;
        } finally {
          await release();
        }
      })();
      downloaded = result.bytes;
      archiveFileName = result.archiveFileName;
    } catch (err) {
      return downloadFailure(formatErrorMessage(err));
    }

    const archiveType = ((): string | undefined => {
      const explicit = normalizeOptionalLowercaseString(spec.archive);
      if (explicit) {
        return explicit;
      }
      return (
        detectArchiveType(spec.extract === true ? archiveFileName : undefined) ??
        detectArchiveType(filename)
      );
    })();
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
      return downloadFailure("extract requested but archive type could not be detected", {
        stderr: "",
      });
    }

    const stagingDir = path.join(path.dirname(tempArchivePath), "extracted");
    try {
      await fs.promises.mkdir(stagingDir, { mode: 0o700 });
      const { extractSkillDownloadArchive } = await import("./install-extract.js");
      const extractResult = await extractSkillDownloadArchive({
        archivePath: tempArchivePath,
        archiveType,
        targetDir: stagingDir,
        stripComponents: spec.stripComponents,
        timeoutMs,
      });
      if (extractResult.code === 0) {
        // Extraction never reopens the published archive or trusts its mutable destination path.
        const targetRelativePath = path.relative(canonicalRoot, targetDir);
        if (targetRelativePath) {
          await pinnedRoot.mkdir(targetRelativePath);
        } else {
          await pinnedRoot.ensureRoot();
        }

        const publishDirectory = async (relativeDir: string): Promise<void> => {
          const sourceDir = path.join(stagingDir, relativeDir);
          for (const entry of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
            const relativePath = path.join(relativeDir, entry.name);
            const sourcePath = path.join(stagingDir, relativePath);
            const destinationPath = path.join(targetRelativePath, relativePath);
            const sourceStat = await fs.promises.lstat(sourcePath);
            try {
              if (sourceStat.isDirectory()) {
                await pinnedRoot.mkdir(destinationPath);
                await publishDirectory(relativePath);
                continue;
              }
              if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
                throw new Error(`archive staging contains unsupported entry: ${relativePath}`);
              }
              await pinnedRoot.copyIn(destinationPath, sourcePath, {
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
      return downloadFailure(formatErrorMessage(err), { code: 1 });
    }
  });
}
