import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "../../memory-host-sdk/host/types.js";
import { resolveMemorySearchStaleness } from "../../memory-host-sdk/host/types.js";
import { getActiveMemorySearchManagerCore } from "../../plugins/memory-runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 50;

export type MemorySearchResponse = {
  agentId: string;
  provider: string;
  searchMode: "hybrid" | "fts-only";
  results: MemorySearchResult[];
  stale?: true;
  warning?: string;
  action?: string;
};

function resolveSearchMode(status: MemoryProviderStatus): MemorySearchResponse["searchMode"] {
  const statusMode = status.custom?.searchMode;
  if (statusMode === "hybrid" || statusMode === "fts-only") {
    return statusMode;
  }
  return status.provider === "none" || status.vector?.enabled === false ? "fts-only" : "hybrid";
}

function resolveSearchOptions(
  params: Record<string, unknown>,
): Parameters<MemorySearchManager["search"]>[1] | null {
  const rawMaxResults = params.maxResults;
  if (
    rawMaxResults !== undefined &&
    (typeof rawMaxResults !== "number" || !Number.isFinite(rawMaxResults))
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
    maxResults,
    ...(rawMinScore === undefined ? {} : { minScore: rawMinScore }),
  };
}

function hasUsableAgentIdInput(value: string): boolean {
  // A valid suffix exposes whether the input contributes any canonical id characters
  // without allowing normalizeAgentId's empty-input fallback to select `main`.
  return normalizeAgentId(`${value}a`) !== "a";
}

function isClosedMemorySearchManagerError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes("database is not open") ||
    message.includes("database connection is not open") ||
    message.includes("database handle is closed") ||
    message.includes("memory index manager is closed")
  );
}

/** Operator-scoped search over the active agent memory index. */
export const memorySearchHandlers: GatewayRequestHandlers = {
  "memory.search": async ({ params, respond, context }) => {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const query = typeof record.query === "string" ? record.query.trim() : "";
    if (!query) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "query must be a non-empty string"),
      );
      return;
    }
    const searchOptions = resolveSearchOptions(record);
    if (!searchOptions) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "maxResults and minScore must be finite numbers when provided",
        ),
      );
      return;
    }

    const cfg = context.getRuntimeConfig();
    const hasAgentId = Object.hasOwn(record, "agentId");
    if (hasAgentId && typeof record.agentId !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId must be a string"));
      return;
    }
    if (hasAgentId && !hasUsableAgentIdInput(record.agentId as string)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agentId"));
      return;
    }
    const requestedAgentId = hasAgentId ? normalizeAgentId(record.agentId as string) : null;
    // Read-scoped input must not bootstrap state or index files for invented agent namespaces.
    if (requestedAgentId !== null && !listAgentIds(cfg).includes(requestedAgentId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agentId"));
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
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
    }
    let acquired: Awaited<ReturnType<typeof getActiveMemorySearchManagerCore>>;
    try {
      // Gateway searches share one query-only reader per agent/config identity.
      // Memory Core prepares missing or obsolete state through its writer before returning it.
      acquired = await getActiveMemorySearchManagerCore({
        cfg,
        agentId,
        purpose: "search",
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `memory search unavailable: ${formatErrorMessage(error)}`,
        ),
      );
      return;
    }
    let { manager } = acquired;
    const transientManagers = new Set<MemorySearchManager>();
    if (acquired.transient && manager) {
      transientManagers.add(manager);
    }
    const { error: acquireError } = acquired;
    if (!manager) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, acquireError ?? "memory search unavailable"),
      );
      return;
    }

    const searchOnce = async () => {
      if (!manager) {
        throw new Error("memory search unavailable");
      }
      return {
        results: await manager.search(query, searchOptions),
        status: manager.status(),
      };
    };

    try {
      let searched;
      try {
        searched = await searchOnce();
      } catch (error) {
        if (!isClosedMemorySearchManagerError(error)) {
          throw error;
        }
        const refreshed = await getActiveMemorySearchManagerCore({
          cfg,
          agentId,
          purpose: "search",
        });
        if (!refreshed.manager) {
          throw new Error(refreshed.error ?? "memory search unavailable", { cause: error });
        }
        manager = refreshed.manager;
        if (refreshed.transient) {
          transientManagers.add(manager);
        }
        searched = await searchOnce();
      }
      const payload: MemorySearchResponse = {
        agentId,
        provider: searched.status.provider,
        searchMode: resolveSearchMode(searched.status),
        results: searched.results,
        ...resolveMemorySearchStaleness(searched.status, agentId),
      };
      respond(true, payload, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory search failed: ${formatErrorMessage(error)}`),
      );
    } finally {
      await Promise.all(
        Array.from(transientManagers, async (transientManager) => {
          await transientManager.close?.().catch(() => undefined);
        }),
      );
    }
  },
};
