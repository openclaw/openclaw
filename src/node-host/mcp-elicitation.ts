import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import {
  MCP_ELICITATION_TIMEOUT_MS,
  runWithMcpElicitationHandler,
  type McpElicitationHandler,
} from "../agents/mcp-client-elicitation.js";
import { bindMcpClientElicitation } from "../agents/mcp-client-elicitation.runtime.js";
import { createMcpRequestLifecycle } from "../agents/mcp-request-lifecycle.js";
import type { NodeHostClient } from "./client.js";

/** The Gateway binds this opaque id to the conversation that owns the call. */
function forwardQuestion(gateway: NodeHostClient, id?: string): McpElicitationHandler {
  return async ({ method, params, signal }) => {
    if (
      !id ||
      method !== "elicitation/create" ||
      !gateway.serverCapabilities?.has(GATEWAY_SERVER_CAPS.NODE_MCP_ELICITATION)
    ) {
      return { action: "decline" };
    }
    signal.throwIfAborted();
    const requestId = randomUUID();
    const cancel = () => {
      void gateway
        .request("node.event", {
          event: "mcp.elicitation",
          payload: { id, requestId, cancel: true },
        })
        .catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await gateway.request<Awaited<ReturnType<McpElicitationHandler>>>(
        "node.event",
        { event: "mcp.elicitation", payload: { id, requestId, params } },
        // The active tool deadline and the Gateway question timeout own cancellation.
        { timeoutMs: null, signal },
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
}

export function bindNodeMcpElicitation(client: Client, gateway: NodeHostClient) {
  const withElicitation = bindMcpClientElicitation(client);
  const lifecycle = createMcpRequestLifecycle(MCP_ELICITATION_TIMEOUT_MS);
  return async <T>(
    id: string | undefined,
    options: { timeout: number; signal: AbortSignal },
    request: (options: { timeout: number; signal: AbortSignal }) => Promise<T>,
  ) => {
    // A server can finish the tool while a question is still open.
    const call = new AbortController();
    const timeout = Math.min(MAX_TIMER_TIMEOUT_MS, options.timeout + MCP_ELICITATION_TIMEOUT_MS);
    try {
      return await lifecycle.run(
        { requestTimeoutMs: options.timeout },
        (signal, holdForHumanInput) => {
          const invoke = () => request({ timeout, signal });
          return runWithMcpElicitationHandler(forwardQuestion(gateway, id), () =>
            withElicitation(signal, invoke, holdForHumanInput),
          );
        },
        AbortSignal.any([options.signal, call.signal]),
      );
    } finally {
      call.abort();
    }
  };
}
