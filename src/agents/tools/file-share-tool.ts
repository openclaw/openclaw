import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  type AliyunOssConfig,
  fileExtension,
  type OssUploadResult,
  resolveOssConfig,
  uploadFileToOss,
} from "../../infra/aliyun-oss.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { type AnyAgentTool, jsonResult, readStringParam, ToolInputError } from "./common.js";

const log = createSubsystemLogger("file-share-tool");

type FileShareToolDeps = {
  resolveConfig: () => AliyunOssConfig | null;
  uploadFile: (params: {
    config: AliyunOssConfig;
    localPath: string;
    displayName: string;
  }) => Promise<OssUploadResult>;
};

type FileShareToolOptions = {
  /** Agent workspace root; uploads are restricted to files inside it. */
  workspaceDir?: string;
  /** Trusted session key, used for audit logging only (never model args). */
  agentSessionKey?: string;
  /** Test seam; production callers omit this. */
  deps?: FileShareToolDeps;
};

const defaultDeps: FileShareToolDeps = {
  resolveConfig: resolveOssConfig,
  uploadFile: uploadFileToOss,
};

const FileShareToolSchema = Type.Object({
  path: Type.String({
    description:
      "Path of the file to share, inside the agent workspace (relative to the workspace root, or absolute within it).",
  }),
  filename: Type.Optional(
    Type.String({
      description:
        "Download filename shown to the user (e.g. 舆情速报_20260611.docx). Defaults to the file's own name.",
    }),
  ),
});

/**
 * Containment check against the real workspace root: symlinks resolved on both
 * sides so a link pointing outside the workspace cannot smuggle files out.
 */
async function resolveContainedPath(workspaceDir: string, requested: string): Promise<string> {
  const workspaceReal = await fs.realpath(workspaceDir);
  const absolute = path.isAbsolute(requested) ? requested : path.resolve(workspaceReal, requested);
  let fileReal: string;
  try {
    fileReal = await fs.realpath(absolute);
  } catch {
    throw new ToolInputError(`file not found: ${requested}`);
  }
  const relative = path.relative(workspaceReal, fileReal);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolInputError("path must point to a file inside the agent workspace");
  }
  return fileReal;
}

/**
 * file_share — upload a workspace file to Aliyun OSS and return a permanent
 * public download link (https://oss.ibtai.com/…). This is the only delivery
 * channel that reaches web users: their chat runs remotely, so workspace paths
 * and "saved to your desktop" claims are meaningless to them.
 */
export function createFileShareTool(opts?: FileShareToolOptions): AnyAgentTool | null {
  const deps = opts?.deps ?? defaultDeps;
  const config = deps.resolveConfig();
  if (!config || !opts?.workspaceDir) {
    return null;
  }
  const workspaceDir = opts.workspaceDir;

  return {
    label: "Share file",
    name: "file_share",
    description:
      "Upload a file from the agent workspace to cloud storage and get a permanent public download URL for the user. Use this whenever the user asks to download or receive a generated file (report, spreadsheet, slides). Reply with the returned URL — never tell the user a file was saved to a local path or desktop.",
    parameters: FileShareToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const requestedPath = readStringParam(params, "path", { required: true });
      const requestedName = readStringParam(params, "filename");

      const filePath = await resolveContainedPath(workspaceDir, requestedPath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new ToolInputError("path must point to a regular file");
      }
      const maxBytes = config.maxFileSizeMb * 1024 * 1024;
      if (stat.size > maxBytes) {
        throw new ToolInputError(`file too large (max ${config.maxFileSizeMb}MB)`);
      }

      const displayName = (requestedName?.trim() || path.basename(filePath)).replace(/[/\\]/g, "_");
      const extension = fileExtension(displayName);
      if (!extension || !config.allowedExtensions.includes(extension)) {
        throw new ToolInputError(
          `file type ".${extension || "?"}" is not allowed for sharing (allowed: ${config.allowedExtensions.join(", ")})`,
        );
      }

      try {
        const result = await deps.uploadFile({
          config,
          localPath: filePath,
          displayName,
        });
        log.info(
          `file_share: uploaded ${path.basename(filePath)} (${result.size} bytes) ` +
            `for session=${opts?.agentSessionKey ?? "unknown"} -> ${result.objectKey}`,
        );
        return jsonResult({
          ok: true,
          url: result.url,
          filename: displayName,
          size: result.size,
          note: "Permanent public download link. Share this URL with the user.",
        });
      } catch (err) {
        // Keep credentials/host details out of model-visible errors.
        log.warn(`file_share: upload failed: ${formatErrorMessage(err)}`);
        throw new ToolInputError("Could not upload the file right now. Please try again.");
      }
    },
  };
}
