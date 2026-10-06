import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  validateSkillsLibraryUploadParams,
  type SkillsLibraryUploadParams,
  type SkillsLibraryUploadResult,
  type SkillsLibraryImportParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { installSkillFromClawHub } from "../lifecycle/clawhub.js";
import { SkillLibraryError } from "../skill-library-error.js";
import {
  prepareSkillLibraryBundle,
  readSkillLibraryTree,
  SKILL_LIBRARY_MAX_PATH_COMPONENTS,
  SKILL_LIBRARY_MAX_TREE_ENTRIES,
} from "./bundle.js";
import { saveSkillLibrary, skillLibraryReceipt } from "./service.js";
import { captureSkillLibraryAccess } from "./store-access.js";
import type { SkillLibraryAuthority } from "./store.js";

async function publishDirectory(
  authority: SkillLibraryAuthority,
  slug: string,
  directory: string,
  options: OpenClawStateDatabaseOptions,
  uploadId?: string,
) {
  const files = await readSkillLibraryTree(directory);
  prepareSkillLibraryBundle(files);
  const markdown = files.find((file) => file.path === "SKILL.md")!;
  return saveSkillLibrary(
    authority,
    {
      slug,
      expectedRevision: null,
      content: Buffer.from(markdown.content, "base64").toString("utf8"),
      files: files.filter(
        (file) => file !== markdown && !/^\.(?:clawhub|clawdhub)\//u.test(file.path),
      ),
    },
    options,
    uploadId,
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
  if (!validateSkillsLibraryUploadParams(params)) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Invalid library upload parameters.");
  }
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
