import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  type SkillsLibraryUploadParams,
  type SkillsLibraryUploadResult,
  type SkillsLibraryImportParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { resolveArchiveKind } from "../../infra/archive.js";
import { readResponseWithLimit } from "../../infra/http-response-body.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { assertCanonicalPathWithinBase } from "../../infra/install-safe-path.js";
import { fetchWithSsrFGuard, withStrictGuardedFetchMode } from "../../infra/net/fetch-guard.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { installSkillFromClawHub } from "../lifecycle/clawhub.js";
import { SkillLibraryError } from "../skill-library-error.js";
import {
  decodeSkillLibraryFile,
  prepareSkillLibraryBundle,
  readSkillLibraryTree,
  SKILL_LIBRARY_MAX_PATH_COMPONENTS,
  SKILL_LIBRARY_MAX_TREE_ENTRIES,
} from "./bundle.js";
import { saveSkillLibrary, skillLibraryReceipt, type SkillLibraryImportPolicy } from "./service.js";
import { resolveSkillLibraryUrl } from "./source-url.js";
import { captureSkillLibraryAccess } from "./store-access.js";
import type { SkillLibraryAuthority } from "./store.js";

async function publishDirectory(
  authority: SkillLibraryAuthority,
  slug: string,
  directory: string,
  options: OpenClawStateDatabaseOptions,
  uploadId?: string,
  importPolicy?: SkillLibraryImportPolicy,
) {
  const files = await readSkillLibraryTree(directory);
  prepareSkillLibraryBundle(files);
  const markdown = files.find((file) => file.path === "SKILL.md")!;
  return saveSkillLibrary(
    authority,
    {
      slug,
      expectedRevision: null,
      content: decodeSkillLibraryFile(markdown).toString("utf8"),
      files: files.filter(
        (file) => file !== markdown && !/^\.(?:clawhub|clawdhub)\//u.test(file.path),
      ),
    },
    options,
    uploadId,
    importPolicy,
  );
}

/** Imports through the existing source policy/verification flow into private temporary artifacts. */
export async function importSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryImportParams,
  options: OpenClawStateDatabaseOptions = {},
) {
  const access = captureSkillLibraryAccess(authority, options);
  await access.read("profile", undefined);
  return withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-library-source-" },
    async ({ dir }) => {
      if (params.source.kind === "url") {
        const source = resolveSkillLibraryUrl(params.source);
        const allowedOrigins = authority.getConfig().skills?.library?.import?.allowedOrigins;
        const networkPolicy = JSON.stringify(allowedOrigins ?? []);
        const assertCurrent = () => {
          access.assertCurrent();
          authority.assertFileMutationAllowed?.();
          // Recheck after DNS/redirect awaits and before publication; retry instead of settling an old grant.
          if (
            JSON.stringify(authority.getConfig().skills?.library?.import?.allowedOrigins ?? []) !==
            networkPolicy
          ) {
            throw new SkillLibraryError(
              "POLICY_BLOCKED",
              "Skill import network policy changed. Retry the import.",
            );
          }
        };
        const { response, release } = await fetchWithSsrFGuard(
          withStrictGuardedFetchMode({
            url: source.url,
            policy: { allowedOrigins },
            timeoutMs: 120_000,
            maxRedirects: 3,
            beforeRequest: assertCurrent,
            resolveDispatcherPolicy: (target) => {
              if (target.protocol !== "https:") {
                throw new SkillLibraryError(
                  "INVALID_BUNDLE",
                  "Skill downloads must remain on HTTPS.",
                );
              }
              return undefined;
            },
          }),
        );
        try {
          if (!response.ok) {
            throw new SkillLibraryError(
              "INVALID_BUNDLE",
              "Skill download failed (HTTP " +
                response.status +
                "). Use a direct SKILL.md or bounded archive URL.",
            );
          }
          if (/text\/html|application\/xhtml/iu.test(response.headers.get("content-type") ?? "")) {
            throw new SkillLibraryError(
              "INVALID_BUNDLE",
              "This URL returned a webpage. Use a raw SKILL.md or archive URL and relative directory.",
            );
          }
          const file =
            source.file ||
            (!source.path &&
              !resolveArchiveKind(new URL(source.url).pathname) &&
              ["text/plain", "text/markdown", "text/x-markdown"].includes(
                response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "",
              ));
          const bytes = await readResponseWithLimit(
            response,
            file ? SKILL_LIBRARY_MAX_FILE_BYTES : SKILL_LIBRARY_MAX_BUNDLE_BYTES,
            {
              onOverflow: () =>
                new SkillLibraryError(
                  "INVALID_BUNDLE",
                  "The download exceeds the existing skill bundle limits. Use a smaller skill bundle/archive URL.",
                ),
            },
          );
          assertCurrent();
          const importPolicy: SkillLibraryImportPolicy = {
            source: {
              kind: file ? "file" : "archive",
              authority: "third-party",
              mutable: true,
              network: true,
            },
            requestedSpecifier: redactSensitiveUrlLikeString(source.url),
          };
          if (file) {
            const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            if (/^\s*(?:<!doctype\s+html|<html)[\s>]/iu.test(content)) {
              throw new SkillLibraryError(
                "INVALID_BUNDLE",
                "This URL returned HTML, not SKILL.md.",
              );
            }
            return await saveSkillLibrary(
              { ...authority, assertCurrent },
              { slug: params.slug, content, expectedRevision: null },
              access.options,
              undefined,
              importPolicy,
            );
          }
          // Whole-repository archives share the upload limits; large repositories need a smaller bundle URL.
          const archivePath = path.join(
            dir,
            /\.(?:tar\.gz|tgz)$/iu.test(new URL(source.url).pathname) ||
              /gzip/iu.test(response.headers.get("content-type") ?? "")
              ? "source.tgz"
              : /\.tar$/iu.test(new URL(source.url).pathname)
                ? "source.tar"
                : "source.zip",
          );
          await fs.writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
          const result = await withExtractedArchiveRoot({
            archivePath,
            tempDirPrefix: "openclaw-library-url-",
            timeoutMs: 120_000,
            rootMarkers: ["SKILL.md"],
            limits: {
              maxArchiveBytes: SKILL_LIBRARY_MAX_BUNDLE_BYTES,
              maxExtractedBytes: SKILL_LIBRARY_MAX_BUNDLE_BYTES,
              maxEntryBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
              maxEntries: SKILL_LIBRARY_MAX_TREE_ENTRIES + 1,
              maxEntryPathComponents: SKILL_LIBRARY_MAX_PATH_COMPONENTS + 1,
            },
            onExtracted: async (rootDir) => {
              const directory = path.resolve(rootDir, source.path);
              try {
                await assertCanonicalPathWithinBase({
                  baseDir: rootDir,
                  candidatePath: directory,
                  boundaryLabel: "skill archive",
                });
                if (!(await fs.stat(directory)).isDirectory()) {
                  throw new Error("not a directory");
                }
              } catch {
                throw new SkillLibraryError(
                  "INVALID_BUNDLE",
                  "Selected archive directory is missing or outside the archive. Use a relative directory inside the unpacked root.",
                );
              }
              return {
                ok: true as const,
                receipt: await publishDirectory(
                  { ...authority, assertCurrent },
                  params.slug,
                  directory,
                  access.options,
                  undefined,
                  importPolicy,
                ),
              };
            },
          });
          if (!result.ok) {
            throw new SkillLibraryError(
              "INVALID_BUNDLE",
              result.error + " Use a smaller skill bundle/archive URL with its relative directory.",
            );
          }
          return result.receipt;
        } finally {
          await release();
        }
      }
      const installed = await installSkillFromClawHub({
        workspaceDir: dir,
        slug: params.source.slug,
        version: params.source.version,
        config: authority.getConfig(),
      });
      access.assertCurrent();
      if (!installed.ok) {
        throw new SkillLibraryError("POLICY_BLOCKED", installed.error);
      }
      return publishDirectory(
        { ...authority, assertCurrent: access.assertCurrent },
        params.slug,
        installed.targetDir,
        access.options,
      );
    },
  );
}

/** Upload bytes never enter the admin upload store; every stage resolves the durable profile anew. */
export async function uploadSkillLibrary(
  authority: SkillLibraryAuthority,
  params: SkillsLibraryUploadParams,
  options: OpenClawStateDatabaseOptions = {},
): Promise<SkillsLibraryUploadResult> {
  const access = captureSkillLibraryAccess(authority, options);
  if (params.action !== "commit") {
    return access.write("skillLibrary.upload", { params });
  }
  const prepared = await access.read("upload", { uploadId: params.uploadId });
  const upload = prepared.value;
  if (upload.published_skill_id) {
    return skillLibraryReceipt(
      (await access.read("entry", { skillId: upload.published_skill_id })).value,
      "unchanged",
    );
  }
  const bytes = Buffer.from(upload.archive_blob);
  if (
    bytes.length !== upload.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== upload.sha256
  ) {
    throw new SkillLibraryError(
      "INVALID_BUNDLE",
      "Upload is incomplete or its SHA-256 does not match.",
    );
  }
  return withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-library-import-" },
    async ({ dir }) => {
      const archivePath = path.join(dir, "skill.zip");
      authority.assertFileMutationAllowed?.();
      await fs.writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
      const result = await withExtractedArchiveRoot({
        archivePath,
        tempDirPrefix: "openclaw-library-extract-",
        timeoutMs: 120_000,
        rootMarkers: ["SKILL.md"],
        limits: {
          maxArchiveBytes: SKILL_LIBRARY_MAX_BUNDLE_BYTES,
          maxExtractedBytes: SKILL_LIBRARY_MAX_BUNDLE_BYTES,
          maxEntryBytes: SKILL_LIBRARY_MAX_FILE_BYTES,
          // Packed roots may have one wrapper directory outside the library tree.
          maxEntries: SKILL_LIBRARY_MAX_TREE_ENTRIES + 1,
          maxEntryPathComponents: SKILL_LIBRARY_MAX_PATH_COMPONENTS + 1,
        },
        onExtracted: async (rootDir) => ({
          ok: true as const,
          receipt: await publishDirectory(
            {
              ...authority,
              assertCurrent: () => {
                prepared.assertCurrent();
                if (upload.expires_at <= Date.now()) {
                  throw new SkillLibraryError("NOT_FOUND", "Upload expired. Start a new import.");
                }
              },
            },
            upload.slug,
            rootDir,
            access.options,
            upload.upload_id,
          ),
        }),
      });
      if (!result.ok) {
        throw new SkillLibraryError("INVALID_BUNDLE", result.error);
      }
      return result.receipt;
    },
  );
}
