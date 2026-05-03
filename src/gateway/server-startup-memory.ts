import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryBackendConfig,
  type ResolvedQmdConfig,
} from "../memory-host-sdk/host/backend-config.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";

function shouldRunQmdStartupBootSync(qmd: ResolvedQmdConfig): boolean {
  return qmd.update.onBoot && qmd.update.startup !== "off";
}

function hasExplicitAgentMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  return listAgentEntries(cfg).some(
    (entry) => normalizeAgentId(entry.id) === agentId && entry.memorySearch != null,
  );
}

function shouldEagerlyStartAgentMemory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentCount: number;
}): boolean {
  if (params.agentCount <= 1) {
    return true;
  }
  if (params.agentId === resolveDefaultAgentId(params.cfg)) {
    return true;
  }
  if (params.cfg.agents?.defaults?.memorySearch?.enabled === true) {
    return true;
  }
  return hasExplicitAgentMemorySearchConfig(params.cfg, params.agentId);
}

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const armedAgentIds: string[] = [];
  const deferredAgentIds: string[] = [];
  for (const agentId of agentIds) {
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (!resolved) {
      continue;
    }
    if (resolved.backend !== "qmd" || !resolved.qmd) {
      continue;
    }
    if (!shouldRunQmdStartupBootSync(resolved.qmd)) {
      continue;
    }
    if (
      !shouldEagerlyStartAgentMemory({
        cfg: params.cfg,
        agentId,
        agentCount: agentIds.length,
      })
    ) {
      deferredAgentIds.push(agentId);
      continue;
    }

    const { manager, error } = await getActiveMemorySearchManager({
      cfg: params.cfg,
      agentId,
      purpose: "cli",
    });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    try {
      await manager.sync?.({ reason: "boot", force: true });
    } catch (err) {
      params.log.warn(`qmd memory startup boot sync failed for agent "${agentId}": ${String(err)}`);
      continue;
    } finally {
      await manager.close?.().catch((err) => {
        params.log.warn(
          `qmd memory startup manager close failed for agent "${agentId}": ${String(err)}`,
        );
      });
    }
    armedAgentIds.push(agentId);
  }
  if (armedAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup boot sync completed for ${formatAgentCount(armedAgentIds.length)}: ${armedAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
  if (deferredAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup initialization deferred for ${formatAgentCount(deferredAgentIds.length)}: ${deferredAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
}

/**
 * Eagerly preload memory managers at gateway startup for every agent whose
 * `memorySearch.sources` includes `"sessions"`.
 *
 * Why this exists
 * ---------------
 * `MemoryIndexManager.get` subscribes to session-transcript mutation events
 * (`emitSessionTranscriptUpdate`) only when it is instantiated, via
 * `ensureSessionListener()`. Without this preload the manager is lazy-loaded
 * on the first `memory_search` tool call, which means any session-transcript
 * event emitted before that first tool call (notably the `archiveFileOnDisk`
 * emit when the user issues `/reset` or `/new`) lands in an empty listener
 * set and is lost. The resulting `.jsonl.reset.<iso>` /
 * `.jsonl.deleted.<iso>` archive file sits on disk but is never indexed
 * until the user triggers `memory index --force`.
 *
 * `startGatewayMemoryBackend` above only runs for the `qmd` backend (via
 * `resolveGatewayMemoryStartupPolicy`), so builtin-backend deployments never
 * exercise any eager-preload path. This function covers the builtin backend
 * specifically, independent of qmd boot-sync policy.
 *
 * Design notes
 * ------------
 * - `purpose` is deliberately left unset so the cached manager is non-transient
 *   and `ensureSessionListener()` runs.
 * - The manager is intentionally NOT closed: closing would call
 *   `sessionUnsubscribe()` and defeat the whole point of the preload. The
 *   manager is kept in the module-level cache so subsequent `memory_search`
 *   calls reuse the same instance.
 * - Any agent-level failure is logged with `log.warn` and does not abort
 *   startup; other agents continue to initialize.
 */
export async function startGatewayMemorySessionListeners(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  // Builtin-only scope (Codex review #76666): the qmd backend returns a
  // `FallbackMemoryManager` wrapper from `getActiveMemorySearchManager`, whose
  // inner `MemoryIndexManager` is only constructed by `fallbackFactory` on a
  // later search/fallback code path. Calling it here would NOT run
  // `ensureSessionListener()`, so the advertised coverage would be misleading.
  // Arming the qmd listener owner is deferred to a follow-up PR; for now we
  // skip eager preload entirely when the qmd backend is active, and rely on
  // `startGatewayMemoryBackend` + qmd's own sync/watch paths.
  if (params.cfg.memory?.backend === "qmd") {
    params.log.info?.(
      "memory session-listener preload skipped: qmd backend is intentionally out of scope (see #76666 review); follow-up PR will arm the qmd listener owner.",
    );
    return;
  }
  const readyAgentIds: string[] = [];
  for (const agentId of listAgentIds(params.cfg)) {
    const settings = resolveMemorySearchConfig(params.cfg, agentId);
    if (!settings) {
      continue;
    }
    const sources = settings.sources;
    if (!Array.isArray(sources) || !sources.includes("sessions")) {
      continue;
    }
    try {
      const { manager, error } = await getActiveMemorySearchManager({
        cfg: params.cfg,
        agentId,
      });
      if (!manager) {
        params.log.warn(
          `memory session-listener preload failed for agent "${agentId}": ${error ?? "unknown error"}`,
        );
        continue;
      }
      readyAgentIds.push(agentId);
      // Intentionally do NOT close manager: closing unsubscribes the session
      // listener we just attached. The manager stays in the module cache.
    } catch (err) {
      params.log.warn(
        `memory session-listener preload threw for agent "${agentId}": ${String(err)}`,
      );
    }
  }
  if (readyAgentIds.length > 0) {
    params.log.info?.(
      `memory session-listener preload armed for ${formatAgentCount(readyAgentIds.length)}: ${readyAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
}

function formatAgentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}
