import fsSync from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { listMemoryFiles } from "./internal.js";
import { requireNodeSqlite } from "./sqlite.js";

const log = createSubsystemLogger("memory");

export type StaleMemoryAgentIndexDiagnostic = {
  agentId: string;
  dbPath: string;
  staleCount: number;
  missingPaths: string[];
};

function toRelativeMemoryPath(workspaceDir: string, absPath: string): string {
  return path.relative(workspaceDir, absPath).replace(/\\/g, "/");
}

function readIndexedMemoryPaths(dbPath: string): Set<string> {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const filesTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get("files") as { name?: string } | undefined;
    if (!filesTable?.name) {
      return new Set();
    }
    const rows = db.prepare(`SELECT path FROM files WHERE source = ?`).all("memory") as Array<{
      path: string;
    }>;
    return new Set(
      rows.map((row) => row.path?.trim()).filter((rowPath): rowPath is string => Boolean(rowPath)),
    );
  } finally {
    db.close();
  }
}

export async function detectStaleMemoryAgentIndexes(
  cfg: OpenClawConfig,
): Promise<StaleMemoryAgentIndexDiagnostic[]> {
  const diagnostics: StaleMemoryAgentIndexDiagnostic[] = [];
  for (const agentId of listAgentIds(cfg)) {
    const resolved = resolveMemorySearchConfig(cfg, agentId);
    if (!resolved?.enabled || !resolved.sources.includes("memory")) {
      continue;
    }
    const backend = resolveMemoryBackendConfig({ cfg, agentId });
    if (backend.backend !== "builtin") {
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const activeFiles = await listMemoryFiles(
      workspaceDir,
      resolved.extraPaths,
      resolved.multimodal,
    );
    if (activeFiles.length === 0) {
      continue;
    }

    const activePaths = new Set(
      activeFiles.map((entry) => toRelativeMemoryPath(workspaceDir, entry)),
    );
    const dbPath = path.resolve(resolved.store.path);
    let indexedPaths = new Set<string>();

    if (fsSync.existsSync(dbPath)) {
      try {
        indexedPaths = readIndexedMemoryPaths(dbPath);
      } catch (err) {
        log.warn(`memory stale-index check failed for ${agentId}: ${String(err)}`);
        continue;
      }
    }

    const missingPaths = Array.from(activePaths).filter((entry) => !indexedPaths.has(entry));
    if (missingPaths.length === 0) {
      continue;
    }

    diagnostics.push({
      agentId,
      dbPath,
      staleCount: missingPaths.length,
      missingPaths: missingPaths.toSorted(),
    });
  }

  return diagnostics;
}
