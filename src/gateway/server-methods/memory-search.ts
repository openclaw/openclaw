import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  MemoryCliSearchOutcome,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResponse,
} from "../../memory-host-sdk/host/types.js";
import {
  readMemorySearchManagerStatus,
  resolveMemorySearchStaleness,
} from "../../memory-host-sdk/host/types.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import {
  getActiveMemorySearchManagerCore,
  isActiveMemoryProviderNative,
  resolveActiveMemoryBackendConfig,
} from "../../plugins/memory-runtime.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  captureChannelReadScope,
  withChannelReadAuthority,
} from "../../shared/channel-read-authority.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 50;

function resolveSearchMode(status: MemoryProviderStatus): MemorySearchResponse["searchMode"] {
  const statusMode = status.custom?.searchMode;
  if (statusMode === "hybrid" || statusMode === "fts-only") {
    return statusMode;
  }
  return status.provider === "none" || status.vector?.enabled === false ? "fts-only" : "hybrid";
}

function resolveSearchOptions(
  params: Record<string, unknown>,
  cli = false,
): Parameters<MemorySearchManager["search"]>[1] | null {
  const rawMaxResults = params.maxResults;
  if (
    rawMaxResults !== undefined &&
    (typeof rawMaxResults !== "number" || !Number.isFinite(rawMaxResults))
  ) {
    return null;
  }
  if (
    cli &&
    rawMaxResults !== undefined &&
    (!Number.isInteger(rawMaxResults) || rawMaxResults < 1)
  ) {
    return null;
  }
  const maxResults = Math.min(
    MAX_RESULTS,
    Math.max(1, Math.floor(rawMaxResults ?? DEFAULT_MAX_RESULTS)),
  );
  const rawMinScore = params.minScore;
  if (
    rawMinScore !== undefined &&
    (typeof rawMinScore !== "number" || !Number.isFinite(rawMinScore))
  ) {
    return null;
  }
  return {
    ...(cli ? (rawMaxResults === undefined ? {} : { maxResults: rawMaxResults }) : { maxResults }),
    ...(rawMinScore === undefined ? {} : { minScore: rawMinScore }),
  };
}

function hasUsableAgentIdInput(value: string): boolean {
  // A valid suffix exposes whether the input contributes any canonical id characters
  // without allowing normalizeAgentId's empty-input fallback to select `main`.
  return normalizeAgentId(`${value}a`) !== "a";
}

async function searchMemory(options: GatewayRequestHandlerOptions, assertCurrent?: () => void) {
  const { params, respond, context } = options;
  if (!assertCurrent && params?.version === 2) {
    const { memoryProviderHandlers } = await import("./memory-provider.js");
    await memoryProviderHandlers["memory.search"](options);
    return;
  }
  if (params?.version !== undefined && params.version !== 1) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, "unsupported memory version");
    return;
  }
  const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const query = typeof record.query === "string" ? record.query : "";
  const searchQuery = assertCurrent ? query : query.trim();
  if (!query.trim()) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, "query must be a non-empty string");
    return;
  }
  const searchOptions = resolveSearchOptions(record, Boolean(assertCurrent));
  if (!searchOptions) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      assertCurrent
        ? "maxResults must be a positive integer and minScore a finite number when provided"
        : "maxResults and minScore must be finite numbers when provided",
    );
    return;
  }

  const cfg = context.getRuntimeConfig();
  if (assertCurrent) {
    const slot = normalizePluginsConfig(cfg.plugins).slots.memory;
    if (slot !== "memory-core") {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        `Memory Core search is unavailable for the selected memory slot. Use the selected plugin's memory tools.`,
      );
      return;
    }
  }
  const hasAgentId = Object.hasOwn(record, "agentId");
  if (hasAgentId && typeof record.agentId !== "string") {
    respondError(respond, ErrorCodes.INVALID_REQUEST, "agentId must be a string");
    return;
  }
  if (hasAgentId && !hasUsableAgentIdInput(record.agentId as string)) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, "unknown agentId");
    return;
  }
  const requestedAgentId = hasAgentId ? normalizeAgentId(record.agentId as string) : null;
  // Read-scoped input must not bootstrap state or index files for invented agent namespaces.
  if (requestedAgentId !== null && !listAgentIds(cfg).includes(requestedAgentId)) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, "unknown agentId");
    return;
  }
  let agentId = requestedAgentId;
  if (!agentId) {
    try {
      agentId = resolveDefaultAgentId(cfg, {
        surface: "memory search",
        hint: "Pass agentId to select a configured agent.",
      });
    } catch (error) {
      if (!(error instanceof AgentSelectionRequiredError)) {
        throw error;
      }
      respondError(respond, ErrorCodes.INVALID_REQUEST, error.message);
      return;
    }
  }
  // Only a native owner is asked for its backend; a legacy runtime keeps its manager calls.
  const backend = isActiveMemoryProviderNative({ cfg, agentId })
    ? resolveActiveMemoryBackendConfig({ cfg, agentId })
    : null;
  if (backend?.backend === "provider-runtime") {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      `memory plugin "${backend.providerId}" uses the provider runtime; retry memory.search with version: 2`,
    );
    return;
  }
  let acquired: Awaited<ReturnType<typeof getActiveMemorySearchManagerCore>> | undefined;
  const readScope = assertCurrent ? captureChannelReadScope() : undefined;
  // Register before acquisition so revoked reads still close the returned manager.
  readScope?.registerResource({
    key: "memory-search-manager",
    settle: async () => {
      await acquired?.manager?.close?.();
    },
  });
  try {
    // Use the transient CLI lifecycle so request cleanup cannot close a shared manager.
    // manager.search owns the same lazy/on-search sync behavior as the existing CLI path.
    acquired = await getActiveMemorySearchManagerCore({
      cfg,
      agentId,
      purpose: "cli",
      ...(assertCurrent ? { inspectSources: true } : {}),
    });
  } catch (error) {
    respondError(
      respond,
      ErrorCodes.UNAVAILABLE,
      `memory search unavailable: ${formatErrorMessage(error)}`,
    );
    return;
  }
  const { manager, error: acquireError } = acquired;
  if (!manager) {
    if (assertCurrent) {
      assertCurrent();
      const outcome: MemoryCliSearchOutcome = acquireError?.trim()
        ? { agentId, status: "failed", error: acquireError }
        : { agentId, status: "disabled" };
      respond(true, outcome, undefined);
      return;
    }
    respondError(respond, ErrorCodes.UNAVAILABLE, acquireError ?? "memory search unavailable");
    return;
  }

  let readRebuildWarning: () => string | undefined = () => undefined;
  try {
    if (assertCurrent) {
      assertCurrent();
      if (!acquired.searchForCli) {
        throw new Error("The memory runtime does not support CLI search.");
      }
      const payload = await acquired.searchForCli({
        manager,
        cfg,
        agentId,
        query: searchQuery,
        ...searchOptions,
        assertCurrent,
      });
      assertCurrent();
      respond(true, payload, undefined);
      return;
    }
    const { captureMemoryRebuildNotice } = loadBundledPluginPublicArtifactModuleSync<{
      captureMemoryRebuildNotice: (status: MemoryProviderStatus) => () => string | undefined;
    }>({ dirName: "memory-core", artifactBasename: "search-api.js" });
    readRebuildWarning = captureMemoryRebuildNotice(
      await readMemorySearchManagerStatus(manager, { includeCounts: false }),
    );
    const results = await manager.search(searchQuery, searchOptions);
    const status = await readMemorySearchManagerStatus(manager, { includeCounts: false });
    const staleness = resolveMemorySearchStaleness(status, agentId);
    const warning = [staleness?.warning, readRebuildWarning()]
      .filter((message): message is string => typeof message === "string")
      .join(" ");
    const payload: MemorySearchResponse = {
      agentId,
      provider: status.provider,
      searchMode: resolveSearchMode(status),
      results,
      ...staleness,
      ...(warning ? { warning } : {}),
    };
    respond(true, payload, undefined);
  } catch (error) {
    respondError(
      respond,
      ErrorCodes.UNAVAILABLE,
      [`memory search failed: ${formatErrorMessage(error)}`, readRebuildWarning()]
        .filter(Boolean)
        .join(" "),
    );
  } finally {
    if (!readScope) {
      await manager.close?.().catch(() => {});
    }
  }
}

/** Operator-scoped search over the active agent memory index. */
export const memorySearchHandlers: GatewayRequestHandlers = {
  "memory.get": async (options) => {
    const { memoryProviderHandlers } = await import("./memory-provider.js");
    await memoryProviderHandlers["memory.get"](options);
  },
  "memory.status": async (options) => {
    const { memoryProviderHandlers } = await import("./memory-provider.js");
    await memoryProviderHandlers["memory.status"](options);
  },
  "memory.search": (options) => searchMemory(options),
  "memory.search.owner": async (options) => {
    const expectedOwnerId = options.params?.expectedOwnerId;
    if (typeof expectedOwnerId !== "string" || !expectedOwnerId.trim()) {
      respondError(options.respond, ErrorCodes.INVALID_REQUEST, "expectedOwnerId is required");
      return;
    }
    let domainEntered = false;
    try {
      const assertCurrent = captureLocalStateMutationGuard(expectedOwnerId, options);
      await withChannelReadAuthority(
        assertCurrent,
        async () => {
          domainEntered = true;
          let response: Parameters<GatewayRequestHandlerOptions["respond"]> | undefined;
          await searchMemory(
            {
              ...options,
              respond: (...args) => {
                response = args;
              },
            },
            assertCurrent,
          );
          return response;
        },
        options.signal,
        (response) => {
          if (response) {
            options.respond(...response);
          }
        },
      );
    } catch (error) {
      options.respond(
        false,
        undefined,
        domainEntered
          ? errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error))
          : localStateOwnerChangedError(error),
      );
    }
  },
};
