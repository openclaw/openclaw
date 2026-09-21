import {
  ErrorCodes,
  errorShape,
  type WebSearchTestResult,
  validateWebSearchStatusParams,
  validateWebSearchTestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeWebSearchOutput,
  unwrapWebSearchOutputText,
} from "../../agents/tools/web-search-output.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { runtimeWebSecretOwnerId } from "../../secrets/runtime-web-secret-owner.js";
import { runWebSearch } from "../../web-search/runtime.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";
import { prepareWebSearchStatus } from "./web-search-status.js";

function hasSearchAuthority(
  options: GatewayRequestHandlerOptions,
  required: "read" | "admin",
): boolean {
  const { client, signal, hasCurrentClientAuthority } = options;
  return Boolean(
    client &&
    !client.invalidated &&
    !client.connectionSignal?.aborted &&
    (client.connect.scopes?.includes("operator.admin") ||
      (required === "read" && client.connect.scopes?.includes("operator.read"))) &&
    !signal?.aborted &&
    (!hasCurrentClientAuthority || hasCurrentClientAuthority()),
  );
}

// Provider diagnostics may contain reflected credentials or request headers.
function searchTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|auth|credential|api.?key|secret/i.test(message)) {
    return "The search provider could not authenticate. Check its credentials and account access.";
  }
  if (/429|rate.?limit|quota|billing|credit/i.test(message)) {
    return "The search provider rejected the request because of an account or rate limit. Check its usage and billing.";
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return "The search request was cancelled or timed out. Check connectivity and try again.";
  }
  return "The search provider could not complete the request. Check its endpoint, connectivity, and provider status.";
}

export const webSearchHandlers: GatewayRequestHandlers = {
  "webSearch.status": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateWebSearchStatusParams, "webSearch.status", respond)) {
      return;
    }
    if (Boolean(params.modelProvider) !== Boolean(params.modelId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "modelProvider and modelId must be supplied together.",
        ),
      );
      return;
    }
    if (!hasSearchAuthority(options, "read")) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Current read access is required to inspect search settings.",
        ),
      );
      return;
    }
    const requesterProfileId = resolveAuthenticatedProfileId(options.client);
    try {
      const prepared = await prepareWebSearchStatus(context, params, requesterProfileId);
      if (prepared.error) {
        respond(false, undefined, prepared.error);
      } else if (
        !hasSearchAuthority(options, "read") ||
        resolveAuthenticatedProfileId(options.client) !== requesterProfileId ||
        context.getRuntimeConfig() !== prepared.config
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Search settings changed. Refresh and try again."),
        );
      } else {
        respond(true, prepared.status, undefined);
      }
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Search settings are not ready. Refresh and try again."),
      );
    }
  },
  "webSearch.test": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateWebSearchTestParams, "webSearch.test", respond)) {
      return;
    }
    const query = params.query.trim();
    if (!query || Boolean(params.modelProvider) !== Boolean(params.modelId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Provide a search query and both model selection fields, or neither.",
        ),
      );
      return;
    }
    if (!hasSearchAuthority(options, "admin")) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Current administrator access is required to test search.",
        ),
      );
      return;
    }
    const requesterProfileId = resolveAuthenticatedProfileId(options.client);
    try {
      const prepared = await prepareWebSearchStatus(context, params, requesterProfileId);
      if (prepared.error) {
        respond(false, undefined, prepared.error);
        return;
      }
      const { status, config, agentDir } = prepared;
      const hasCurrentAuthority = () =>
        hasSearchAuthority(options, "admin") &&
        resolveAuthenticatedProfileId(options.client) === requesterProfileId &&
        context.getRuntimeConfig() === config;
      if (!hasCurrentAuthority()) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Search settings or access changed. Refresh and try again.",
          ),
        );
        return;
      }
      const explicitProvider = params.providerId?.trim();
      const provider = explicitProvider ?? status.route.provider;
      const canTest = explicitProvider
        ? explicitProvider === status.testProvider?.id
        : status.route.kind === "managed" && status.route.testable;
      if (!canTest || !provider) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            status.route.reason ?? "Choose an available search provider before testing.",
          ),
        );
        return;
      }
      const startedAt = Date.now();
      let result: WebSearchTestResult;
      try {
        assertSecretOwnerAvailable("capability", runtimeWebSecretOwnerId("search", provider));
        const signal = AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          ...(options.client?.connectionSignal ? [options.client.connectionSignal] : []),
          AbortSignal.timeout((config.tools?.web?.search?.timeoutSeconds ?? 30) * 1_000),
        ]);
        const executed = await runWebSearch({
          config: {
            ...config,
            tools: {
              ...config.tools,
              web: {
                ...config.tools?.web,
                search: { ...config.tools?.web?.search, cacheTtlMinutes: 0 },
              },
            },
          },
          preferInputConfig: true,
          agentDir,
          providerId: provider,
          args: { query, count: 5 },
          signal,
          assertCurrent: () => {
            if (!hasCurrentAuthority()) {
              throw new Error("Search settings or access changed during the test.");
            }
            assertSecretOwnerAvailable("capability", runtimeWebSecretOwnerId("search", provider));
          },
        });
        const normalized = normalizeWebSearchOutput({ ...executed, query });
        const latencyMs = Date.now() - startedAt;
        if (normalized.kind === "results") {
          result = {
            provider: executed.provider,
            latencyMs,
            status: "ok",
            results: normalized.results.map((row) => ({
              title: unwrapWebSearchOutputText(row.title),
              url: row.url,
              ...(row.snippet ? { snippet: unwrapWebSearchOutputText(row.snippet) } : {}),
            })),
            cached: normalized.cached === true,
          };
        } else if (normalized.kind === "answer") {
          result = {
            provider: executed.provider,
            latencyMs,
            status: "ok",
            content: unwrapWebSearchOutputText(normalized.content),
            citations: normalized.citations?.map((row) => ({
              url: row.url,
              ...(row.title ? { title: unwrapWebSearchOutputText(row.title) } : {}),
            })),
            cached: normalized.cached === true,
          };
        } else {
          result = {
            provider,
            latencyMs,
            status: "error",
            error:
              normalized.kind === "error"
                ? searchTestError(normalized.message)
                : "The provider returned a response without supported search results or an answer.",
          };
        }
      } catch (error) {
        result = {
          provider,
          latencyMs: Date.now() - startedAt,
          status: "error",
          error: searchTestError(error),
        };
      }
      if (!hasCurrentAuthority()) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Search settings or access changed during the test. Refresh and try again.",
          ),
        );
        return;
      }
      respond(true, result, undefined);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Search settings are not ready. Refresh and try again."),
      );
    }
  },
};
