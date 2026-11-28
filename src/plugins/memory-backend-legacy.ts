import { stripMemoryAnnotationCarriers } from "../../packages/memory-host-sdk/src/host/curated-annotations.js";
import {
  isAutomaticMemoryEntryEligible,
  readMemorySearchManagerStatus,
  resolveMemorySearchStaleness,
  type MemoryProviderStatus,
  type MemorySearchResult,
} from "../memory-host-sdk/host/types.js";
import type { MemoryProviderHandle, MemorySearchHit } from "./memory-provider-runtime-types.js";
import type {
  MemoryProviderOpenParams,
  MemoryProviderOpenResult,
} from "./memory-provider-types.js";
import { runPluginCleanup } from "./plugin-instance-scope.js";
import type { MemoryPluginRuntime, MemoryProviderRuntime } from "./registry-contribution-types.js";

/**
 * Presents a file-shaped memory runtime as a backend provider runtime. Opening goes through
 * the same legacy adapter the host uses when such a plugin owns the memory slot, so hit
 * authorization, references, and read limits are identical in both roles.
 */
export function createLegacyBackendProviderRuntime(
  pluginId: string,
  runtime: MemoryPluginRuntime,
): MemoryProviderRuntime {
  return {
    open: (params) => adaptLegacyMemoryProvider(runtime, pluginId, params),
    ...(runtime.prepareReload ? { prepareReload: runtime.prepareReload.bind(runtime) } : {}),
    ...(runtime.closeMemorySearchManager
      ? { closeMemorySearchManager: runtime.closeMemorySearchManager.bind(runtime) }
      : {}),
    ...(runtime.closeAllMemorySearchManagers
      ? { closeAllMemorySearchManagers: runtime.closeAllMemorySearchManagers.bind(runtime) }
      : {}),
  };
}

function legacyCoverageWarning(status: MemoryProviderStatus): string | undefined {
  const stale = resolveMemorySearchStaleness(status);
  if (stale) {
    return stale.warning;
  }
  const providerState = status.custom?.providerState;
  if (providerState && typeof providerState === "object" && "mode" in providerState) {
    // Pending describes this manager's initialization, not stored vector coverage.
    // Empty and complete indexes remain usable before embeddings initialize.
    const indexState = status.vector?.index?.state;
    if (
      providerState.mode === "pending" &&
      status.requestedProvider !== "none" &&
      indexState !== "complete" &&
      indexState !== "empty"
    ) {
      return "Memory embeddings are pending. Search results may be incomplete.";
    }
    if (
      providerState.mode === "degraded" ||
      (providerState.mode === "fts-only" &&
        status.requestedProvider !== undefined &&
        status.requestedProvider !== "none")
    ) {
      return "Memory embeddings are unavailable. Keyword search remains available; results may be incomplete.";
    }
  }
  if (status.dirty) {
    return "Memory indexing is pending. Search results may be incomplete.";
  }
  // A deliberately keyword-only provider does not promise semantic coverage.
  if (
    status.provider !== "none" &&
    status.vector?.enabled &&
    (status.vector.index?.state === "incomplete" || status.vector.index?.state === "unverified")
  ) {
    return "Memory vector indexing is incomplete. Search results may be incomplete.";
  }
  return undefined;
}

// Health reaches every operator.read caller; host filesystem layout stays with local status tools.
function redactLegacyHealthDetails(status: MemoryProviderStatus) {
  const { workspaceDir: _workspaceDir, dbPath: _dbPath, extraPaths: _extraPaths, ...rest } = status;
  if (!rest.vector) {
    return rest;
  }
  const { extensionPath: _extensionPath, ...vector } = rest.vector;
  return { ...rest, vector };
}

/** Translate the legacy contract without mutating managers or changing their receiver. */
export async function adaptLegacyMemoryProvider(
  runtime: MemoryPluginRuntime,
  providerId: string,
  params: MemoryProviderOpenParams,
): Promise<MemoryProviderOpenResult> {
  const result = await runtime.getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
  });
  const manager = result.manager;
  if (!manager) {
    return { provider: null, error: result.error };
  }
  const { context } = params;
  const session = context.authority.kind === "session" ? context.authority : undefined;
  const assertCurrent = () => {
    context.assertCurrent();
    context.signal?.throwIfAborted();
  };
  const authorize = async (hits: MemorySearchResult[]) => {
    assertCurrent();
    const authorized = runtime.authorizeSearchHits
      ? await runtime.authorizeSearchHits({
          cfg: params.cfg,
          agentId: params.agentId,
          requesterSessionKey: session?.sessionKey,
          // Host and operator callers act for the opened agent without a session, as
          // `memory.search` v1 and Memory Wiki did; session callers keep requester visibility
          // plus any recall pass their host granted.
          sandboxed: session?.sandboxed ?? false,
          trustedAgentScope: !session,
          conversationRecall: session?.conversationRecall,
          hits,
        })
      : hits.filter((hit) => hit.source !== "sessions");
    assertCurrent();
    return authorized;
  };
  const convert = (hit: MemorySearchResult): MemorySearchHit => {
    const reference = { providerId, id: hit.path, fragment: `L${hit.startLine}-L${hit.endLine}` };
    const projectKeys = hit.projectKey
      ?.split(";")
      .map((key) => key.trim())
      .filter(Boolean);
    return {
      reference,
      excerpt: stripMemoryAnnotationCarriers(hit.snippet),
      score: hit.score,
      source: hit.source,
      citations: [
        {
          label: hit.citation ?? `${hit.path}#L${hit.startLine}-L${hit.endLine}`,
          reference,
          startLine: hit.startLine,
          endLine: hit.endLine,
        },
      ],
      automaticRecall: {
        // A project annotation without a usable key never matches an active project.
        eligible:
          hit.source === "memory" &&
          isAutomaticMemoryEntryEligible(hit) &&
          projectKeys?.length !== 0,
        projectKeys,
        triggers: hit.triggers,
        importance: hit.importance,
      },
    };
  };
  const readCoverage = async (includeCounts?: boolean) => {
    try {
      const status = await readMemorySearchManagerStatus(manager, { includeCounts });
      return { status, warning: legacyCoverageWarning(status) };
    } catch {
      assertCurrent();
      // Diagnostics must not discard an otherwise successful, authorized search.
      return {
        warning: "Memory index coverage could not be verified. Search results may be incomplete.",
      };
    }
  };
  // Automatic recall consumers keep their legacy manager paths, so the adapter enumerates no candidates.
  const provider: MemoryProviderHandle = {
    capabilities: {
      sources: ["memory", "sessions"],
      pagination: false,
      candidates: [],
      projectFilter: true,
    },
    async search(request) {
      if (request.cursor !== undefined) {
        throw new Error("legacy memory search does not support cursors");
      }
      if (typeof manager.search !== "function") {
        throw new Error("memory runtime manager must implement search");
      }
      const { query, cursor: _cursor, activeProjectKeys, ...options } = request;
      const hits = await manager.search(query, {
        ...options,
        activeProjectKeys: activeProjectKeys ? [...activeProjectKeys] : undefined,
        sessionKey: session?.sessionKey,
        signal: context.signal,
      });
      const authorized = (await authorize(hits)).map(convert);
      const { warning } = await readCoverage(false);
      return {
        hits: authorized,
        coverage: warning ? "partial" : "complete",
        ...(warning ? { warning } : {}),
      };
    },
    async get(request) {
      // readFile is the legacy provider's read authorization boundary, including
      // virtual paths. Search visibility cannot grant a read or replace that policy.
      if (typeof manager.readFile !== "function") {
        throw new Error("memory runtime manager must implement readFile");
      }
      const read = await manager.readFile({
        relPath: request.reference.id,
        from: request.from,
        lines: request.lines,
      });
      if (read.status === "not_found") {
        return { status: "not_found" };
      }
      return {
        status: "ok",
        reference: { providerId, id: read.path },
        text: read.text,
        truncated: read.truncated,
        from: read.from,
        lines: read.lines,
        nextFrom: read.nextFrom,
      };
    },
    async health() {
      const { status, warning } = await readCoverage();
      return {
        status: warning ? "degraded" : "ready",
        message: warning,
        ...(status ? { details: { legacy: redactLegacyHealthDetails(status) } } : {}),
      };
    },
    ...(manager.sync ? { refresh: () => manager.sync!({ reason: "provider-refresh" }) } : {}),
    async close() {
      if (params.purpose === "cli" || params.purpose === "status") {
        await runPluginCleanup(manager, () => manager.close?.());
      }
    },
  };
  return { provider };
}
