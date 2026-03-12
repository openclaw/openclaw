import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";
import {
  normalizeMemoryDocumentPath,
  resolvePathRelativeToRoot,
} from "../persistence/path-keys.js";
import {
  readMemoryDocumentFromPostgres,
  scheduleMemoryDocumentSyncToPostgres,
} from "../persistence/service.js";
import { discoverPersistenceArtifacts } from "../persistence/storage.js";

const memoryDocumentWatchers = new Map<string, FSWatcher>();
const memoryManagerSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function queueMemoryManagerSync(params: { cfg: OpenClawConfig; agentId: string }): void {
  if (!resolveMemorySearchConfig(params.cfg, params.agentId)) {
    return;
  }
  const existing = memoryManagerSyncTimers.get(params.agentId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    memoryManagerSyncTimers.delete(params.agentId);
    void getMemorySearchManager({
      cfg: params.cfg,
      agentId: params.agentId,
    })
      .then(async ({ manager }) => {
        await manager?.sync?.({
          reason: "postgres-memory-watch",
          force: true,
        });
      })
      .catch(() => undefined);
  }, 250);
  memoryManagerSyncTimers.set(params.agentId, timer);
}

function ensurePostgresMemoryWatcher(params: { cfg: OpenClawConfig; agentId: string }): boolean {
  if (params.cfg.persistence?.backend !== "postgres") {
    return false;
  }
  const workspaceRoot = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  if (!workspaceRoot) {
    return false;
  }
  const watcherKey = `${params.agentId}\0${workspaceRoot}`;
  if (memoryDocumentWatchers.has(watcherKey)) {
    return true;
  }
  const watchPaths = [
    path.join(workspaceRoot, "MEMORY.md"),
    path.join(workspaceRoot, "memory.md"),
    path.join(workspaceRoot, "memory", "**", "*.md"),
  ];
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 100,
    },
  });
  const syncPath = (absolutePath: string) => {
    const relativePath = resolvePathRelativeToRoot(workspaceRoot, absolutePath);
    const logicalPath = relativePath ? normalizeMemoryDocumentPath(relativePath) : undefined;
    if (!logicalPath) {
      return;
    }
    scheduleMemoryDocumentSyncToPostgres({
      workspaceRoot,
      absolutePath,
      logicalPath,
      agentId: params.agentId,
    });
    queueMemoryManagerSync(params);
  };
  watcher.on("add", syncPath);
  watcher.on("change", syncPath);
  watcher.on("unlink", syncPath);
  memoryDocumentWatchers.set(watcherKey, watcher);
  return true;
}

async function validatePostgresMemoryCutover(cfg: OpenClawConfig): Promise<void> {
  if (cfg.persistence?.backend !== "postgres") {
    return;
  }
  const artifacts = await discoverPersistenceArtifacts(cfg, process.env);
  if (artifacts.memoryDocuments.length === 0) {
    return;
  }

  const missing: string[] = [];
  for (const document of artifacts.memoryDocuments) {
    const body = await readMemoryDocumentFromPostgres({
      config: cfg,
      lookupMode: "runtime",
      workspaceRoot: document.workspaceRoot,
      logicalPath: document.logicalPath,
    });
    if (body === null) {
      missing.push(document.logicalPath);
      if (missing.length >= 5) {
        break;
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Memory documents exist on disk but are missing from Postgres (${missing.join(", ")}). Run \`openclaw storage migrate --to postgres\` before enabling Postgres persistence.`,
    );
  }
}

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  await validatePostgresMemoryCutover(params.cfg);
  const agentIds = listAgentIds(params.cfg);
  for (const agentId of agentIds) {
    let armed = ensurePostgresMemoryWatcher({
      cfg: params.cfg,
      agentId,
    });
    const memorySearchEnabled = resolveMemorySearchConfig(params.cfg, agentId);
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    const shouldArmWatcher =
      params.cfg.persistence?.backend === "postgres" ||
      (resolved.backend === "qmd" && !!resolved.qmd);
    if (!shouldArmWatcher) {
      continue;
    }
    if (!memorySearchEnabled) {
      if (armed) {
        params.log.info?.(`memory startup initialization armed for agent "${agentId}"`);
      }
      continue;
    }

    const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    armed = true;
    params.log.info?.(`memory startup initialization armed for agent "${agentId}"`);
  }
}
