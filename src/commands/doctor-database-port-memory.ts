import path from "node:path";
import { listAgentEntriesWithSource, listAgentIds } from "../agents/agent-roster.js";
import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import { getMemoryEmbeddingCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { createConfigIO } from "../config/io.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import { readMemorySearchManagerStatus } from "../memory-host-sdk/host/types.js";
import { getActiveMemorySearchManagerCore } from "../plugins/memory-runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { listDefaultAgentDatabasePaths } from "../state/agent-database-path-discovery.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";

type MemoryRebuildTarget = { agentId: string; path: string };
type MemoryRebuildResult = MemoryRebuildTarget & {
  status: "rebuilt" | "failed";
  elapsedMs?: number;
  files?: number;
  chunks?: number;
  warning?: string;
};

function failed(target: MemoryRebuildTarget, reason: string): MemoryRebuildResult {
  return {
    ...target,
    status: "failed",
    warning: `${reason} Run: openclaw memory index --agent ${target.agentId}`,
  };
}

/** Consume the published config under fresh offline custody, never the port's old selection. */
export async function rebuildPortedAgentMemory(params: {
  stateDir: string;
  stores: readonly string[];
}): Promise<MemoryRebuildResult[]> {
  const ported = new Set(params.stores.map((file) => path.resolve(file)));
  let targets: MemoryRebuildTarget[] = [];
  try {
    // Keep recovery guidance available even if acquiring the new owner fails.
    targets = (await listDefaultAgentDatabasePaths(params.stateDir)).filter((target) =>
      ported.has(target.path),
    );
    return await runWithLocalStateOwner({
      method: "memory.cli",
      params: {},
      target: "ported memory stores",
      databaseEngine: "configured",
      onForeignOwner: "refuse",
      runLocal: async ({ env, assertCurrent }) => {
        // Port publication intentionally leaves the running command's config snapshot unchanged.
        const config = await createConfigIO({
          env,
          configPath: env.OPENCLAW_CONFIG_PATH,
          observe: false,
          pluginValidation: "skip",
        }).loadConfigAsync({ assertCurrent });
        const registered = await inspectOpenClawRegisteredAgentDatabases({ env });
        const known = new Map(
          [
            ...registered,
            ...targets,
            ...resolveConfiguredAgentDatabaseTargets(config, {
              env,
              registeredDatabases: registered,
            }),
          ].map((target) => [
            path.resolve(target.path),
            { agentId: target.agentId, path: path.resolve(target.path) },
          ]),
        );
        targets = [...known.values()].filter((target) => ported.has(path.resolve(target.path)));
        const configured = new Set(listAgentIds(config));
        const agents = listAgentEntriesWithSource(config);
        const targetIds = getMemoryEmbeddingCommandSecretTargetIds(config);
        const secretTargets = discoverConfigSecretTargetsByIds(config, targetIds);
        const results: MemoryRebuildResult[] = [];
        for (const target of targets) {
          if (
            !configured.has(target.agentId) ||
            path.resolve(target.path) !==
              resolveOpenClawAgentSqlitePath({
                agentId: target.agentId,
                env,
              })
          ) {
            results.push(
              failed(
                target,
                "Retained store needs its original agent configuration before rebuilding.",
              ),
            );
            continue;
          }
          const started = performance.now();
          try {
            const source = agents.find(
              ({ entry }) => normalizeAgentId(entry.id) === target.agentId,
            )?.source;
            // A broken peer's credentials must not prevent this agent from rebuilding.
            const allowedPaths = new Set(
              secretTargets
                .filter(({ pathSegments: [root, kind, key] }) =>
                  root !== "agents" || (kind !== "entries" && kind !== "list")
                    ? true
                    : source?.kind === kind &&
                      key === (source.kind === "entries" ? source.key : source.index),
                )
                .map(({ path: secretPath }) => secretPath),
            );
            const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
              config,
              commandName: "memory index",
              targetIds,
              allowedPaths,
              agentId: target.agentId,
              mode: "enforce_resolved",
            });
            assertCurrent();
            const { manager } = await getActiveMemorySearchManagerCore({
              cfg: resolvedConfig,
              agentId: target.agentId,
              purpose: "cli",
              inspectSources: true,
            });
            if (!manager) {
              results.push(failed(target, "The selected memory plugin is unavailable."));
              continue;
            }
            let outcome: MemoryRebuildResult;
            try {
              if (!manager.sync) {
                outcome = failed(target, "The selected memory plugin does not support indexing.");
              } else {
                assertCurrent();
                await manager.sync({ reason: "cli" });
                const status = await readMemorySearchManagerStatus(manager);
                outcome =
                  status.lastSyncError || status.dirty
                    ? failed(target, "The memory index rebuild did not complete.")
                    : {
                        ...target,
                        status: "rebuilt",
                        elapsedMs: Math.round(performance.now() - started),
                        files: status.files,
                        chunks: status.chunks,
                      };
              }
            } finally {
              await manager.close?.();
            }
            results.push(outcome);
          } catch {
            // Provider errors can contain credentials or source text; return only recovery guidance.
            results.push(
              failed(target, "Memory rebuild failed after the database port completed."),
            );
          }
        }
        return results;
      },
    });
  } catch {
    return targets.map((target) =>
      failed(target, "Memory rebuild could not acquire or finish offline ownership."),
    );
  }
}
