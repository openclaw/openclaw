import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceSyncConfig } from "../config/types.agent-defaults.js";
import { getChildLogger } from "../logging/logger.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  resolveDefaultAgentWorkspaceDir,
} from "./workspace.js";

const logger = getChildLogger({ subsystem: "workspace-sync" });

export const ALLOWED_SYNC_FILENAMES = new Set([
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
]);

// 2MB per file should be more than enough for markdown configuration files
export const MAX_SYNC_FILE_BYTES = 2 * 1024 * 1024;

export type WorkspaceManifest = {
  version: number;
  files: Record<string, string>;
  sha256?: string;
};

export type WorkspaceSyncResult = {
  ok: boolean;
  filesUpdated: string[];
  error?: string;
};

function generateManifestHash(files: Record<string, string>): string {
  const hash = crypto.createHash("sha256");
  const sortedKeys = Object.keys(files).toSorted();
  for (const key of sortedKeys) {
    hash.update(`${key}:${files[key]}`);
  }
  return hash.digest("hex");
}

function validateSyncUrl(urlStr: string, allowInsecure: boolean): URL | Error {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return new Error(`Invalid URL scheme: ${url.protocol} (expected https: or http:)`);
    }
    if (url.protocol === "http:" && !allowInsecure) {
      // Allow localhost HTTP by default even if allowInsecure is false
      if (
        url.hostname !== "localhost" &&
        url.hostname !== "127.0.0.1" &&
        url.hostname !== "[::1]"
      ) {
        return new Error("HTTP URL used without allowInsecure=true in configuration.");
      }
    }
    return url;
  } catch (err) {
    return new Error(`Invalid URL format: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pullWorkspaceManifest(
  config: WorkspaceSyncConfig,
): Promise<WorkspaceManifest> {
  if (!config.url) {
    throw new Error("Workspace sync URL is not configured.");
  }

  const urlRes = validateSyncUrl(config.url, !!config.allowInsecure);
  if (urlRes instanceof Error) {
    throw urlRes;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  try {
    const response = await fetch(urlRes.toString(), {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`Remote returned HTTP ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as unknown;
    if (!json || typeof json !== "object") {
      throw new Error("Invalid manifest: Expected JSON object at root.");
    }

    const manifest = json as Partial<WorkspaceManifest>;
    if (manifest.version !== 1) {
      throw new Error(`Unsupported manifest version: ${manifest.version} (expected 1)`);
    }

    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
      throw new Error("Invalid manifest: 'files' must be an object.");
    }

    // Validate size
    for (const [filename, content] of Object.entries(manifest.files)) {
      if (typeof content !== "string") {
        throw new Error(`Invalid manifest: content for '${filename}' is not a string.`);
      }
      if (Buffer.byteLength(content, "utf8") > MAX_SYNC_FILE_BYTES) {
        throw new Error(`Invalid manifest: file '${filename}' exceeds maximum allowed size (2MB).`);
      }
    }

    return {
      version: 1,
      files: manifest.files,
      sha256: manifest.sha256,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to pull workspace manifest: ${reason}`, { cause: err });
  }
}

export async function applyWorkspaceManifest(
  manifest: WorkspaceManifest,
  workspaceDir: string = resolveDefaultAgentWorkspaceDir(),
): Promise<string[]> {
  const filesToUpdate: { filename: string; tempPath: string; finalPath: string }[] = [];
  const updatedFilesLog: string[] = [];

  try {
    await fs.mkdir(workspaceDir, { recursive: true });

    // 1. Prepare temp files
    for (const [filename, content] of Object.entries(manifest.files)) {
      if (!ALLOWED_SYNC_FILENAMES.has(filename)) {
        logger.debug(`Skipping unhandled file '${filename}' in manifest.`);
        continue;
      }
      const finalPath = path.join(workspaceDir, filename);
      const tempPath = path.join(workspaceDir, `.${filename}.tmp.sync`);

      await fs.writeFile(tempPath, content, "utf8");
      filesToUpdate.push({ filename, tempPath, finalPath });
    }

    // 2. Commit files (atomic rename overrides existing files)
    for (const { filename, tempPath, finalPath } of filesToUpdate) {
      await fs.rename(tempPath, finalPath);
      updatedFilesLog.push(filename);
    }

    return updatedFilesLog;
  } finally {
    // 3. Cleanup any dangling tmp files if something failed mid-way
    for (const { tempPath } of filesToUpdate) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore errors (file usually doesn't exist if rename succeeded)
      }
    }
  }
}

export async function pullAndApplyWorkspaceSync(
  config: WorkspaceSyncConfig,
  workspaceDir: string = resolveDefaultAgentWorkspaceDir(),
): Promise<WorkspaceSyncResult> {
  if (!config.enabled) {
    return { ok: false, filesUpdated: [], error: "Workspace sync is disabled in configuration." };
  }

  try {
    logger.debug(`Pulling workspace manifest from ${config.url}`);
    const manifest = await pullWorkspaceManifest(config);

    // Optional hash check
    if (manifest.sha256) {
      const computedHash = generateManifestHash(manifest.files);
      if (computedHash !== manifest.sha256) {
        throw new Error(
          `Manifest checksum mismatch (expected: ${manifest.sha256}, computed: ${computedHash})`,
        );
      }
    }

    logger.debug(`Applying ${Object.keys(manifest.files).length} files to workspace...`);
    const filesUpdated = await applyWorkspaceManifest(manifest, workspaceDir);

    return { ok: true, filesUpdated };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Workspace sync failed: ${errorMsg}`);
    return { ok: false, filesUpdated: [], error: errorMsg };
  }
}

export async function pushWorkspaceToRemote(
  config: WorkspaceSyncConfig,
  workspaceDir: string = resolveDefaultAgentWorkspaceDir(),
): Promise<WorkspaceSyncResult> {
  const urlStr = config.pushUrl || config.url;
  if (!urlStr) {
    return { ok: false, filesUpdated: [], error: "No URL configured for workspace sync push." };
  }

  const urlRes = validateSyncUrl(urlStr, !!config.allowInsecure);
  if (urlRes instanceof Error) {
    return { ok: false, filesUpdated: [], error: urlRes.message };
  }

  const token = config.pushToken || config.token;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const manifestFiles: Record<string, string> = {};
    const pushedFiles: string[] = [];

    // Read local files
    for (const filename of ALLOWED_SYNC_FILENAMES) {
      try {
        const filePath = path.join(workspaceDir, filename);
        const content = await fs.readFile(filePath, "utf8");
        manifestFiles[filename] = content;
        pushedFiles.push(filename);
      } catch (err: unknown) {
        // Ignore missing files, they just won't be pushed
        if (err && typeof err === "object" && "code" in err && err.code !== "ENOENT") {
          const detail =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : "Unknown filesystem error";
          throw new Error(`Failed to read local file ${filename}: ${detail}`, { cause: err });
        }
      }
    }

    if (Object.keys(manifestFiles).length === 0) {
      return {
        ok: false,
        filesUpdated: [],
        error: "No recognized files found in the workspace to push.",
      };
    }

    const manifest: WorkspaceManifest = {
      version: 1,
      files: manifestFiles,
      sha256: generateManifestHash(manifestFiles),
    };

    logger.debug(`Pushing workspace manifest to ${urlStr}`);
    const response = await fetch(urlRes.toString(), {
      method: "PUT",
      headers,
      body: JSON.stringify(manifest),
    });

    if (!response.ok) {
      throw new Error(`Remote returned HTTP ${response.status} ${response.statusText}`);
    }

    return { ok: true, filesUpdated: pushedFiles };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Workspace sync push failed: ${errorMsg}`);
    return { ok: false, filesUpdated: [], error: errorMsg };
  }
}
