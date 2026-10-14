import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { MemorySearchRequest } from "../../plugins/memory-provider-types.js";
import { getActiveMemoryProviderCore } from "../../plugins/memory-runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { isSyntheticGatewayCaller } from "./gateway-personal-caller.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

function requireNonEmptyStringIfPresent(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNumberIfPresent(value: unknown, name: string, integer = false): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && (!Number.isInteger(value) || value < 1))
  ) {
    throw new TypeError(`${name} must be a ${integer ? "positive integer" : "finite number"}`);
  }
  return value;
}

// Reject malformed or empty source restrictions before provider admission; an empty
// list would otherwise reach legacy managers as "no filter" and broaden the search.
function requireSourcesIfPresent(value: unknown): MemorySearchRequest["sources"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("sources must be a non-empty array of memory or sessions");
  }
  return value.map((source: unknown) => {
    if (source !== "memory" && source !== "sessions") {
      throw new TypeError("sources must contain only memory or sessions");
    }
    return source;
  });
}

function parseOperation(method: string, params: Record<string, unknown>) {
  if (method === "memory.search") {
    const query = requireNonEmptyStringIfPresent(params.query, "query")?.trim();
    if (!query) {
      throw new TypeError("query must be a non-empty string");
    }
    return {
      kind: "search" as const,
      input: {
        query,
        maxResults: Math.min(
          50,
          requireNumberIfPresent(params.maxResults, "maxResults", true) ?? 20,
        ),
        minScore: requireNumberIfPresent(params.minScore, "minScore"),
        cursor: requireNonEmptyStringIfPresent(params.cursor, "cursor"),
        sources: requireSourcesIfPresent(params.sources),
      },
    };
  }
  if (method === "memory.get") {
    const record = params.reference;
    if (!isRecord(record)) {
      throw new TypeError("reference must be a provider-scoped memory reference");
    }
    const providerId = requireNonEmptyStringIfPresent(record.providerId, "reference.providerId");
    const id = requireNonEmptyStringIfPresent(record.id, "reference.id");
    if (!providerId || !id) {
      throw new TypeError("reference.providerId and reference.id are required");
    }
    return {
      kind: "get" as const,
      input: {
        reference: {
          providerId,
          id,
          revision: requireNonEmptyStringIfPresent(record.revision, "reference.revision"),
          fragment: requireNonEmptyStringIfPresent(record.fragment, "reference.fragment"),
        },
        from: requireNumberIfPresent(params.from, "from", true),
        lines: requireNumberIfPresent(params.lines, "lines", true),
      },
    };
  }
  return { kind: "health" as const };
}

/**
 * A connected operator reads with the scopes the dispatcher already authorized for
 * this method, as `memory.search` v1 does. Synthetic, agent-tool, and agent-runtime
 * callers act for an admitted run, so they keep that run's captured operator authority.
 */
async function captureMemoryReadAuthority(
  options: GatewayRequestHandlerOptions,
  assertRequestCurrent: () => void,
): Promise<{ scopes: readonly string[]; assertCurrent: () => void; release: () => void }> {
  const { client, context, signal, hasCurrentClientAuthority } = options;
  if (isSyntheticGatewayCaller(client) || client?.internal?.remoteIngressPrincipal) {
    const captured = await captureGatewayOperatorRunAuthority({
      client,
      context,
      hasCurrentClientAuthority,
      invocationAuthority: { assertCurrent: assertRequestCurrent, signal },
    });
    if (!captured) {
      throw new Error("Memory provider reads require current operator authority");
    }
    return {
      scopes: captured.authority.scopes,
      assertCurrent: () => {
        assertRequestCurrent();
        captured.authority.assertCurrent();
      },
      release: captured.release,
    };
  }
  if (client?.connect?.role !== "operator" || !client.connId) {
    throw new Error("Memory provider reads require an authenticated operator connection");
  }
  return {
    scopes: [...(client.connect.scopes ?? [])],
    assertCurrent: assertRequestCurrent,
    release: () => {},
  };
}

/** Neutral reads deliberately do not use workspace RPCs or Memory Core artifacts. */
async function handleMemoryProviderRequest(options: GatewayRequestHandlerOptions) {
  const { params, req, respond, context, client, signal, hasCurrentClientAuthority } = options;
  const cfg = context.getRuntimeConfig();
  let agentId: string;
  let operation: ReturnType<typeof parseOperation>;
  try {
    operation = parseOperation(req.method, params);
    const requested = requireNonEmptyStringIfPresent(params.agentId, "agentId");
    if (requested !== undefined) {
      agentId = normalizeAgentId(requested);
      if (normalizeAgentId(`${requested}a`) === "a" || !listAgentIds(cfg).includes(agentId)) {
        throw new TypeError("unknown agentId");
      }
    } else {
      agentId = resolveDefaultAgentId(cfg, {
        surface: "memory provider",
        hint: "Pass agentId to select a configured agent.",
      });
    }
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof AgentSelectionRequiredError)) {
      throw error;
    }
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return;
  }

  let open = true;
  const assertRequestCurrent = () => {
    signal?.throwIfAborted();
    client?.connectionSignal?.throwIfAborted();
    if (!open || client?.invalidated || hasCurrentClientAuthority?.() === false) {
      throw new Error("Memory request authority is no longer active");
    }
  };
  let captured: Awaited<ReturnType<typeof captureMemoryReadAuthority>> | undefined;
  let provider: Awaited<ReturnType<typeof getActiveMemoryProviderCore>>["provider"] = null;
  try {
    assertRequestCurrent();
    captured = await captureMemoryReadAuthority(options, assertRequestCurrent);
    const { assertCurrent } = captured;
    assertCurrent();
    const acquired = await getActiveMemoryProviderCore({
      cfg,
      agentId,
      purpose: "cli",
      context: {
        authority: { kind: "operator", scopes: captured.scopes, connId: client?.connId },
        assertCurrent,
        signal,
      },
    });
    provider = acquired.provider;
    if (!provider) {
      throw new Error(acquired.error ?? "Memory provider unavailable");
    }
    const result =
      operation.kind === "search"
        ? await provider.search(operation.input)
        : operation.kind === "get"
          ? await provider.get(operation.input)
          : await provider.health();
    assertCurrent();
    respond(true, { version: 2, agentId, providerId: acquired.providerId, ...result }, undefined);
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
  } finally {
    open = false;
    try {
      await provider?.close();
    } finally {
      captured?.release();
    }
  }
}

export const memoryProviderHandlers = {
  "memory.search": handleMemoryProviderRequest,
  "memory.get": handleMemoryProviderRequest,
  "memory.status": handleMemoryProviderRequest,
} satisfies GatewayRequestHandlers;
