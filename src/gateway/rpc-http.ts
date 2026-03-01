import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

type RpcHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

/**
 * High-performance RPC endpoint for agent turns via SSE.
 * Streams all mind_events (latency, lifecycle, tool, assistant) in real-time.
 */
export async function handleRpcAgentTurnHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RpcHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/rpc/agent/turn",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
  });

  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = handled.body as {
    runId?: string;
    agentId?: string;
    sessionKey?: string;
    message?: string;
    deliver?: boolean;
    channel?: string;
    bestEffortDeliver?: boolean;
  };
  const runId = payload.runId || `rpc_${randomUUID()}`;
  const agentId = payload.agentId || "main";
  const sessionKey = payload.sessionKey;
  const message = payload.message;

  if (!message) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "message required" }));
    return true;
  }

  const deps = createDefaultDeps();
  const commandInput = {
    message,
    agentId,
    sessionKey,
    runId,
    deliver: Boolean(payload.deliver),
    messageChannel: payload.channel || "webchat",
    bestEffortDeliver: Boolean(payload.bestEffortDeliver),
    json: true,
  };

  setSseHeaders(res);

  let closed = false;
  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId || closed) {
      return;
    }

    // Proxy the event as a mind_event for ingest_server.py
    const mindEvent = {
      type: "mind_event",
      stream: evt.stream,
      data: evt.data,
      timestamp: Date.now(),
    };

    res.write(`data: ${JSON.stringify(mindEvent)}\n\n`);

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        // We don't close here, the async runner below will handle it after result is sent.
        unsubscribe();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommand(commandInput, defaultRuntime, deps);
      if (!closed) {
        res.write(
          `data: ${JSON.stringify({
            type: "agent_result",
            result,
            timestamp: Date.now(),
          })}\n\n`,
        );
      }
    } catch (err) {
      logWarn(`rpc-http: agent turn failed: ${String(err)}`);
      if (!closed) {
        res.write(
          `data: ${JSON.stringify({
            type: "mind_event",
            stream: "lifecycle",
            data: { phase: "error", message: String(err) },
            timestamp: Date.now(),
          })}\n\n`,
        );
      }
    } finally {
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}
