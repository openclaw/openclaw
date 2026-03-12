import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";
import { readMemoryDocumentFromPostgres } from "../persistence/service.js";
import { discoverPersistenceArtifacts } from "../persistence/storage.js";

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
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    const shouldArmWatcher =
      params.cfg.persistence?.backend === "postgres" ||
      (resolved.backend === "qmd" && !!resolved.qmd);
    if (!shouldArmWatcher) {
      continue;
    }

    const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    params.log.info?.(`memory startup initialization armed for agent "${agentId}"`);
  }
}
