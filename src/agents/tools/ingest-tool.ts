import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import type { MoltbotConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/search-manager.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const IngestSchema = Type.Object({
  path: Type.String(),
  target_name: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.String()),
});

const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);
const INGEST_SUBDIR = "memory/ingest";
const POLL_DELAYS_MS = [250, 500, 1000];

export function resolveIngestAllowlistRoot(): string {
  const envRoot = process.env.SOPHIE_INGEST_ROOT?.trim();
  if (envRoot) return path.resolve(envRoot);
  return path.join(os.homedir(), "Documents", "SOPHIE_INGEST");
}

function buildFrontMatter(ingestId: string, userMetadata?: string): string {
  const lines = [`ingest_id: ${ingestId}`];
  if (userMetadata) {
    lines.push(userMetadata.trim());
  }
  return `---\n${lines.join("\n")}\n---\n\n`;
}

export function createIngestLocalFileTool(options: {
  config?: MoltbotConfig;
  agentSessionKey?: string;
  workspaceDir?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg || !options.workspaceDir) return null;

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = options.workspaceDir || resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Ingest Local File",
    name: "ingest_local_file",
    description:
      "Copy a local file into Sophie's memory index for search and recall. Only .md and .txt files are supported. The file is queued for background indexing by the memory sync pipeline. Returns INDEXED if confirmed within ~2s, otherwise QUEUED.",
    parameters: IngestSchema,
    execute: async (_toolCallId, params) => {
      const sourcePath = readStringParam(params, "path", { required: true });
      const targetName = readStringParam(params, "target_name");
      const userMetadata = readStringParam(params, "metadata");

      // 1. Validate source exists and is a file
      let stat;
      try {
        stat = await fs.lstat(sourcePath);
      } catch {
        throw new Error(`File not found: ${sourcePath}`);
      }
      if (!stat.isFile()) {
        throw new Error(`Not a regular file: ${sourcePath}`);
      }

      // 2. Enforce allowlist
      const allowlistRoot = resolveIngestAllowlistRoot();
      const resolvedSource = path.resolve(sourcePath);
      const resolvedRoot = path.resolve(allowlistRoot);
      if (!resolvedSource.startsWith(resolvedRoot + path.sep) && resolvedSource !== resolvedRoot) {
        throw new Error(
          `Path outside allowlist. File must be under: ${allowlistRoot}. Set SOPHIE_INGEST_ROOT to change.`,
        );
      }

      // 3. Enforce extension
      const ext = path.extname(sourcePath).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported file type: ${ext}. Only .md and .txt are supported in v0.`);
      }

      // 4. Resolve destination
      const baseName = targetName || path.basename(sourcePath, ext);
      const destFileName = `${baseName}.md`;
      const destDir = path.join(workspaceDir, INGEST_SUBDIR);
      const destPath = path.join(destDir, destFileName);
      const destRelPath = path.join(INGEST_SUBDIR, destFileName);

      // 5. Ensure ingest directory exists
      await fs.mkdir(destDir, { recursive: true });

      // 6. Read source, prepend front-matter with ingest_id, write destination
      const ingestId = `ingest-${randomUUID().slice(0, 8)}`;
      const sourceContent = await fs.readFile(sourcePath, "utf-8");
      const frontMatter = buildFrontMatter(ingestId, userMetadata);
      await fs.writeFile(destPath, frontMatter + sourceContent, "utf-8");

      // 7. Ensure allowlist root directory exists (for default path)
      await fs.mkdir(allowlistRoot, { recursive: true });

      // 8. Poll memory_search for ingest_id with exponential backoff
      try {
        const { manager } = await getMemorySearchManager({ cfg, agentId });
        if (manager) {
          for (const delay of POLL_DELAYS_MS) {
            await new Promise((r) => setTimeout(r, delay));
            const results = await manager.search(ingestId, { maxResults: 5 });
            if (
              results.some((r) => r.path === destRelPath || r.path.endsWith(`/${destFileName}`))
            ) {
              return jsonResult({
                status: "INDEXED",
                destination: destRelPath,
                ingest_id: ingestId,
              });
            }
          }
        }
      } catch {
        // Memory search unavailable; fall through to QUEUED
      }

      return jsonResult({
        status: "QUEUED",
        destination: destRelPath,
        ingest_id: ingestId,
        next_step: `Use memory_search with query "${ingestId}" to check indexing status later`,
      });
    },
  };
}
