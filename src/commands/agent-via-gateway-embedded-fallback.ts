// Fresh-session embedded fallback for the gateway agent CLI: the paths that must
// re-run locally on a brand-new `gateway-fallback-<uuid>` session (gateway
// timeout, and accepted-then-disconnected) instead of reusing a session a
// still-running detached gateway run may own.
import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  EMBEDDED_FALLBACK_META,
  getGatewayDispatchConfig,
  loadAgentSessionModule,
  loadEmbeddedAgentCommand,
  returnAfterSignalExit,
  type AgentCliDeps,
  type AgentCliSignal,
  type AgentDispatchOpts,
} from "./agent-via-gateway.js";

const GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX = "gateway-fallback-";

/**
 * Raised when the gateway already accepted (and detached) a run but the
 * CLI↔gateway connection closed non-transiently before the final frame. The
 * detached gateway run still owns the original session, so the CLI fallback
 * must re-run on a FRESH session (matching the gateway-timeout path) instead of
 * re-executing the same message on the original session and colliding with the
 * in-flight gateway run. Carries the accepted run identity for diagnostics.
 */
export class GatewayAgentAcceptedRunDisconnectError extends Error {
  readonly acceptedRunId: string | undefined;
  readonly acceptedSessionKey: string | undefined;
  constructor(params: {
    acceptedRunId: string | undefined;
    acceptedSessionKey: string | undefined;
    cause: unknown;
  }) {
    super("gateway accepted the run but the connection closed before completion", {
      cause: params.cause,
    });
    this.name = "GatewayAgentAcceptedRunDisconnectError";
    this.acceptedRunId = params.acceptedRunId;
    this.acceptedSessionKey = params.acceptedSessionKey;
  }
}

export function isGatewayAgentAcceptedRunDisconnectError(
  err: unknown,
): err is GatewayAgentAcceptedRunDisconnectError {
  return err instanceof GatewayAgentAcceptedRunDisconnectError;
}

function createGatewayTimeoutFallbackSessionId(): string {
  return `${GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX}${randomUUID()}`;
}

function createGatewayTimeoutFallbackSession(agentId?: string): {
  sessionId: string;
  sessionKey: string;
} {
  const sessionId = createGatewayTimeoutFallbackSessionId();
  return {
    sessionId,
    sessionKey: `agent:${normalizeAgentId(agentId)}:explicit:${sessionId.trim()}`,
  };
}

async function resolveAgentIdForGatewayTimeoutFallback(
  opts: AgentDispatchOpts,
): Promise<string | undefined> {
  const explicitSessionKey = opts.sessionKey?.trim();
  if (classifySessionKeyShape(explicitSessionKey) === "agent") {
    return resolveAgentIdFromSessionKey(explicitSessionKey);
  }
  if (isUnscopedSessionKeySentinel(explicitSessionKey)) {
    return resolveDefaultAgentId(await getGatewayDispatchConfig());
  }

  const agentIdRaw = opts.agent?.trim();
  if (agentIdRaw) {
    return normalizeAgentId(agentIdRaw);
  }

  if (!opts.to && !opts.sessionId) {
    return undefined;
  }
  const cfg = await getGatewayDispatchConfig();
  const { resolveSessionKeyForRequest } = await loadAgentSessionModule();
  const resolvedSessionKey = resolveSessionKeyForRequest({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
  }).sessionKey;
  return classifySessionKeyShape(resolvedSessionKey) === "agent"
    ? resolveAgentIdFromSessionKey(resolvedSessionKey)
    : undefined;
}

/**
 * Runs the embedded agent on a brand-new `gateway-fallback-<uuid>` session. Both
 * the gateway-timeout and accepted-then-disconnected paths use this so the
 * fallback never reuses a session a still-running gateway run may own. The
 * fresh session id doubles as the embedded run id and is reported via
 * `fallbackReason` metadata.
 */
export async function runGatewayEmbeddedFallbackOnFreshSession(params: {
  dispatchOpts: AgentDispatchOpts;
  localOpts: AgentCommandOpts;
  runtime: RuntimeEnv;
  deps: AgentCliDeps | undefined;
  signalBridge: { getReceivedSignal: () => AgentCliSignal | undefined };
  fallbackReason: "gateway_timeout" | "gateway_connection_lost";
  describeFailure: (fallbackSessionId: string) => string;
}) {
  const fallbackAgentId = await resolveAgentIdForGatewayTimeoutFallback(params.dispatchOpts);
  const fallbackSession = createGatewayTimeoutFallbackSession(fallbackAgentId);
  params.runtime.error?.(params.describeFailure(fallbackSession.sessionId));
  const agentCommand = await loadEmbeddedAgentCommand();
  const result = await agentCommand(
    {
      ...params.localOpts,
      sessionId: fallbackSession.sessionId,
      sessionKey: fallbackSession.sessionKey,
      runId: fallbackSession.sessionId,
      resultMetaOverrides: {
        ...EMBEDDED_FALLBACK_META,
        fallbackReason: params.fallbackReason,
        fallbackSessionId: fallbackSession.sessionId,
        fallbackSessionKey: fallbackSession.sessionKey,
      },
    },
    params.runtime,
    params.deps,
  );
  return returnAfterSignalExit(result, params.signalBridge.getReceivedSignal(), params.runtime);
}
