import { stripMemoryAnnotationCarriers } from "../../packages/memory-host-sdk/src/host/curated-annotations.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  isAutomaticMemoryEntryEligible,
  type MemoryProviderStatus,
  type MemorySearchResult,
} from "../memory-host-sdk/host/types.js";
import { assertMemoryCallerCurrent, prepareMemoryCallerRead } from "./memory-audience.js";
import type {
  MemoryCallerContext,
  MemoryProviderHandle,
  MemoryProviderOpenParams,
  MemoryProviderOpenResult,
  MemorySearchHit,
  MemorySearchPage,
  MemoryCitation,
  MemoryReference,
} from "./memory-provider-types.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";

const refreshHandoffs = new WeakMap<
  MemoryProviderHandle,
  (onStarted: () => void) => Promise<void>
>();

/** Join caller admission before handing asynchronous refresh to the provider owner. */
export function refreshMemoryProviderWithHandoff(
  provider: MemoryProviderHandle,
  onStarted: () => void,
): Promise<void> {
  const refresh = refreshHandoffs.get(provider);
  if (!refresh) {
    throw new Error("memory refresh requires a bound provider handle");
  }
  return refresh(onStarted);
}

/** Recheck both caller and provider lifetime after every asynchronous boundary. */
export function bindMemoryProvider(
  provider: MemoryProviderHandle,
  providerId: string,
  context: MemoryCallerContext,
  runtimeOwner?: object,
): MemoryProviderHandle {
  let closed = false;
  const instance =
    getPluginValueInstance(provider) ??
    (runtimeOwner ? getPluginValueInstance(runtimeOwner) : undefined);
  const assertCurrent = () => {
    if (closed) {
      throw new Error("memory provider handle is closed");
    }
    assertMemoryCallerCurrent(context);
    if (
      instance &&
      (!instance.acceptingCalls || instance.owner?.revoked || instance.lifecycle.signal.aborted)
    ) {
      throw new Error("memory provider instance is no longer current");
    }
  };
  const invoke = async <T>(run: () => Promise<T>): Promise<T> => {
    const before = prepareMemoryCallerRead(context);
    if (before) {
      await racePromiseWithAbortSignal(before, context.signal);
    }
    assertCurrent();
    const result = await run();
    const after = prepareMemoryCallerRead(context);
    if (after) {
      await racePromiseWithAbortSignal(after, context.signal);
    }
    assertCurrent();
    return result;
  };
  const assertReference = (reference: MemoryReference) => {
    if (reference.providerId !== providerId) {
      throw new Error("memory reference belongs to a different provider");
    }
  };
  const assertCitations = (citations?: MemoryCitation[]) => {
    for (const citation of citations ?? []) {
      if (citation.reference) {
        assertReference(citation.reference);
      }
    }
  };
  const validatePage = (page: MemorySearchPage) => {
    for (const hit of page.hits) {
      assertReference(hit.reference);
      assertCitations(hit.citations);
    }
    return page;
  };
  const capabilities = Object.freeze({
    ...provider.capabilities,
    sources: Object.freeze([...provider.capabilities.sources]),
    candidates: Object.freeze([...provider.capabilities.candidates]),
  });
  const assertSearchCapabilities = (request: Parameters<MemoryProviderHandle["search"]>[0]) => {
    const unsupportedSource = request.sources?.find(
      (source) => !capabilities.sources.includes(source),
    );
    if (unsupportedSource) {
      throw new Error(
        `memory provider does not support the ${unsupportedSource} source capability`,
      );
    }
    if (request.cursor !== undefined && !capabilities.pagination) {
      throw new Error("memory provider does not support the pagination capability");
    }
    if (request.activeProjectKeys?.length && !capabilities.projectFilter) {
      throw new Error("memory provider does not support the project filter capability");
    }
  };
  const refresh = provider.refresh
    ? (onStarted?: () => void) =>
        invoke(() => {
          const pending = provider.refresh!();
          onStarted?.();
          return pending;
        })
    : undefined;
  const bound: MemoryProviderHandle = {
    capabilities,
    search: (request) =>
      invoke(async () => {
        assertSearchCapabilities(request);
        return validatePage(await provider.search(request));
      }),
    get: (request) =>
      invoke(async () => {
        assertReference(request.reference);
        const result = await provider.get(request);
        if (result.status === "ok") {
          assertReference(result.reference);
          assertCitations(result.citations);
        }
        return result;
      }),
    health: () => invoke(() => provider.health()),
    ...(provider.candidates
      ? {
          candidates: (request: Parameters<NonNullable<MemoryProviderHandle["candidates"]>>[0]) => {
            return invoke(async () => {
              if (!capabilities.candidates.includes(request.kind)) {
                throw new Error(
                  `memory provider does not support the ${request.kind} candidates capability`,
                );
              }
              if (request.activeProjectKeys?.length && !capabilities.projectFilter) {
                throw new Error("memory provider does not support the project filter capability");
              }
              return validatePage(await provider.candidates!(request));
            });
          },
        }
      : {}),
    ...(refresh ? { refresh: () => refresh() } : {}),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      // Lease release is teardown and must remain possible after caller revocation.
      await runPluginCleanup(provider, () => provider.close());
    },
  };
  if (refresh) {
    refreshHandoffs.set(bound, refresh);
  }
  return bound;
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
      return { hits: (await authorize(hits)).map(convert), coverage: "complete" };
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
      const status = manager.status();
      return {
        status: status.lastSyncError ? "degraded" : "ready",
        message: status.lastSyncError,
        details: { legacy: redactLegacyHealthDetails(status) },
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
