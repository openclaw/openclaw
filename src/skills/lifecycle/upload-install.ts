import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ArchiveLogger } from "../../infra/archive.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { installSkillArchiveFromPath } from "./archive-install.js";
import { validateRequestedSkillSlug } from "./install-paths.js";
import { SkillUploadRequestError } from "./upload-store-error.js";
import {
  defaultSkillUploadStore as skillUploadStore,
  normalizeSkillUploadSha256,
} from "./upload-store.js";

export const UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE =
  "Uploaded skill archive installs are disabled by skills.install.allowUploadedArchives";

export function areUploadedSkillArchivesEnabled(config: OpenClawConfig): boolean {
  return config.skills?.install?.allowUploadedArchives === true;
}

export async function installUploadedSkillArchive(params: {
  uploadId: string;
  slug: string;
  force: boolean;
  sha256?: string;
  timeoutMs?: number;
  workspaceDir: string;
  config: OpenClawConfig;
  log?: ArchiveLogger;
  beforePersistentApply?: () => void;
}) {
  if (!areUploadedSkillArchivesEnabled(params.config)) {
    return {
      ok: false as const,
      error: UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE,
      errorKind: "unavailable" as const,
    };
  }
  try {
    params.beforePersistentApply?.();
    const requestedSlug = validateRequestedSkillSlug(params.slug);
    const requestedSha = normalizeSkillUploadSha256(params.sha256);
    return await skillUploadStore.withCommittedUpload(params.uploadId, async (record, upload) => {
      const rejectInvalid = async (error: string) => {
        await upload.remove().catch(() => undefined);
        return { ok: false as const, error, errorKind: "invalid-request" as const };
      };
      if (record.slug !== requestedSlug) {
        return await rejectInvalid("install slug does not match upload slug");
      }
      if (record.force !== params.force) {
        return await rejectInvalid("install force does not match upload force");
      }
      if (requestedSha && requestedSha !== record.actualSha256) {
        return await rejectInvalid("install sha256 does not match uploaded archive");
      }
      if (!record.actualSha256) {
        return await rejectInvalid("committed upload is missing sha256");
      }

      const install = await installSkillArchiveFromPath({
        archivePath: record.archivePath,
        workspaceDir: params.workspaceDir,
        slug: record.slug,
        force: record.force,
        timeoutMs: params.timeoutMs,
        logger: params.log,
        beforePersistentApply: params.beforePersistentApply,
        policy: {
          config: params.config,
          installId: "upload",
          origin: {
            type: "upload",
            uploadId: params.uploadId,
            sha256: record.actualSha256,
          },
          source: { kind: "upload", authority: "user", mutable: false, network: false },
          requestedSpecifier: `upload:${params.uploadId}`,
        },
      });
      if (!install.ok) {
        if (install.failureKind === "invalid-request") {
          await upload.remove().catch(() => undefined);
        }
        return {
          ok: false as const,
          error: install.error,
          errorKind: install.failureKind,
        };
      }
      await upload.remove().catch(() => undefined);
      return {
        ok: true as const,
        message: `Installed ${record.slug}`,
        stdout: "",
        stderr: "",
        code: 0 as const,
        slug: record.slug,
        targetDir: install.targetDir,
        sha256: record.actualSha256,
      };
    });
  } catch (err) {
    const error = err instanceof SkillUploadRequestError ? err.message : formatErrorMessage(err);
    return {
      ok: false as const,
      error,
      errorKind:
        err instanceof SkillUploadRequestError || error.startsWith("Invalid skill slug")
          ? ("invalid-request" as const)
          : ("unavailable" as const),
    };
  }
}
