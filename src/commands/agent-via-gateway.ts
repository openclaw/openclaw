import crypto from "node:crypto";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveSubagentConfiguredModelSelection } from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import {
  ADMIN_SCOPE,
  isAdminOnlyMethod,
  type OperatorScope,
  WRITE_SCOPE,
} from "../gateway/method-scopes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { agentCommand } from "./agent.js";
import { resolveSessionKeyForRequest } from "./agent/session.js";

type AgentGatewayResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
  }>;
  meta?: unknown;
};

type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: AgentGatewayResult;
};

const NO_GATEWAY_TIMEOUT_MS = 2_147_000_000;

export type AgentCliOpts = {
  message: string;
  agent?: string;
  to?: string;
  sessionId?: string;
  thinking?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  channel?: string;
  replyTo?: string;
  replyChannel?: string;
  replyAccount?: string;
  bestEffortDeliver?: boolean;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  local?: boolean;
  /** When true, create an isolated subagent session (agent:<id>:subagent:<uuid>)
   *  instead of reusing the agent's main session. */
  spawn?: boolean;
};

function parseTimeoutSeconds(opts: { cfg: OpenClawConfig; timeout?: string }) {
  const raw =
    opts.timeout !== undefined
      ? Number.parseInt(opts.timeout, 10)
      : (opts.cfg.agents?.defaults?.timeoutSeconds ?? 600);
  if (Number.isNaN(raw) || raw < 0) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  return raw;
}

function formatPayloadForLog(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}) {
  const parts = resolveSendableOutboundReplyParts({
    text: payload.text,
    mediaUrls: payload.mediaUrls,
    mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : undefined,
  });
  const lines: string[] = [];
  if (parts.text) {
    lines.push(parts.text.trimEnd());
  }
  for (const url of parts.mediaUrls) {
    lines.push(`MEDIA:${url}`);
  }
  return lines.join("\n").trimEnd();
}

export async function agentViaGatewayCommand(opts: AgentCliOpts, runtime: RuntimeEnv) {
  const body = (opts.message ?? "").trim();
  if (!body) {
    throw new Error("Message (--message) is required");
  }
  if (!opts.to && !opts.sessionId && !opts.agent && !opts.spawn) {
    throw new Error("Pass --to <E.164>, --session-id, --agent, or --spawn to choose a session");
  }
  // --spawn creates a fresh isolated session by design. Reusing an existing
  // session via --session-id contradicts that, and silently dropping the
  // selector would write into an unrelated orphan session that looks like
  // the caller's conversation. Reject the combination instead.
  if (opts.spawn && opts.sessionId) {
    throw new Error("--spawn creates an isolated session and cannot be combined with --session-id");
  }

  const cfg = loadConfig();
  const agentIdRaw = opts.agent?.trim();
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (agentId) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentId)) {
      throw new Error(
        `Unknown agent id "${agentIdRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  const timeoutSeconds = parseTimeoutSeconds({ cfg, timeout: opts.timeout });
  const gatewayTimeoutMs =
    timeoutSeconds === 0
      ? NO_GATEWAY_TIMEOUT_MS // no timeout (timer-safe max)
      : Math.max(10_000, (timeoutSeconds + 30) * 1000);

  // --spawn creates an isolated subagent session key that won't pollute
  // the agent's main session. The key shape (agent:<id>:subagent:<uuid>)
  // matches what the internal sessions_spawn tool produces.
  let sessionKey: string | undefined;
  let lane: string | undefined;
  let spawnedSessionKey: string | undefined;
  if (opts.spawn) {
    // Resolve the target agent id. When --agent is not set, fall back to the
    // configured default agent via resolveDefaultAgentId — NOT to routing
    // bindings. The CLI outbound path does not consult cfg.bindings[] today
    // (the shared resolveSessionKey canonicalizes direct chats to the default
    // agent regardless of bindings), so the spawn path stays consistent with
    // non-spawn CLI behavior. Callers who need binding-aware agent selection
    // should pass --agent explicitly.
    const spawnAgentId = agentId ?? resolveDefaultAgentId(cfg);
    sessionKey = `agent:${spawnAgentId}:subagent:${crypto.randomUUID()}`;
    spawnedSessionKey = sessionKey;
    lane = "subagent";
    // Pre-patch the session so the gateway records spawnDepth and subagent
    // role — otherwise the subagent would execute with top-level privileges
    // (owner-only tools, further spawns) even though the caller asked for
    // isolation.  A failed patch would silently violate the safety contract
    // advertised by --spawn, so surface the failure instead of proceeding.
    //
    // Also seed the session's model from the agent's configured subagent
    // defaults so downstream consumers that read the session entry directly
    // (e.g. first-turn attachment / image-support resolution in
    // server-methods/agent.ts) pick the subagent-specific model rather than
    // the main-agent model or the global default.  This mirrors the
    // internal sessions_spawn path, which honors
    // `agents.<id>.subagents.model` before falling back to the main model.
    // Only seed when an explicit subagent-scoped model is configured; if
    // nothing specific is set, leave the entry untouched so the gateway's
    // runtime resolver applies its normal cascade.
    const seededModel = resolveSubagentConfiguredModelSelection({
      cfg,
      agentId: spawnAgentId,
    });
    try {
      await callGateway({
        method: "sessions.patch",
        params: {
          key: sessionKey,
          spawnDepth: 1,
          subagentRole: "leaf",
          subagentControlScope: "none",
          ...(seededModel ? { model: seededModel } : {}),
        },
        timeoutMs: 10_000,
        // sessions.patch is admin-only; pin the scope explicitly so the call
        // does not trigger a scope-upgrade handshake on paired gateways
        // (#59428) and so the subsequent agent RPC can stay on a lower scope.
        scopes: resolveSpawnScopes("sessions.patch"),
      });
    } catch (err) {
      throw new Error(
        `--spawn requires the gateway to mark the subagent session as isolated, but sessions.patch failed: ${String(err)}. Refusing to run without subagent restrictions.`,
        { cause: err },
      );
    }
  } else {
    sessionKey = resolveSessionKeyForRequest({
      cfg,
      agentId,
      to: opts.to,
      sessionId: opts.sessionId,
    }).sessionKey;
  }

  const channel = normalizeMessageChannel(opts.channel);
  const idempotencyKey = normalizeOptionalString(opts.runId) || randomIdempotencyKey();

  let response: GatewayAgentResponse;
  try {
    response = await withProgress(
      {
        label: "Waiting for agent reply…",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          method: "agent",
          params: {
            message: body,
            agentId,
            to: opts.to,
            replyTo: opts.replyTo,
            sessionId: opts.sessionId,
            sessionKey,
            thinking: opts.thinking,
            deliver: Boolean(opts.deliver),
            channel,
            replyChannel: opts.replyChannel,
            replyAccountId: opts.replyAccount,
            bestEffortDeliver: opts.bestEffortDeliver,
            timeout: timeoutSeconds,
            lane: lane ?? opts.lane,
            extraSystemPrompt: opts.extraSystemPrompt,
            idempotencyKey,
          },
          expectFinal: true,
          timeoutMs: gatewayTimeoutMs,
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          // For --spawn, drop admin scope on the agent RPC so the gateway
          // does not flag the caller as owner (senderIsOwner) and expose
          // owner-only tools to the leaf subagent. The admin-scoped
          // sessions.patch above already established the session metadata;
          // this second call only needs the least-privilege scope for the
          // agent method (write).
          ...(opts.spawn ? { scopes: resolveSpawnScopes("agent") } : {}),
        }),
    );
  } catch (err) {
    // Intentionally do NOT call sessions.delete on a failed spawned run:
    // - sessions.delete aborts active runs via cleanupSessionBeforeMutation,
    //   so a transport-level failure here (dropped frame, CLI timeout,
    //   reconnect) would cancel a subagent that the gateway already
    //   accepted and is running happily.
    // - We cannot distinguish "run never started" from "run is in flight
    //   but client lost the reply" from this point, so auto-cleanup is
    //   unsafe by default.
    // Surface the session key so the user can decide whether to delete the
    // entry manually via `openclaw sessions delete --key <key>` once the
    // run is known to be finished.
    if (spawnedSessionKey) {
      runtime.error?.(
        `--spawn run failed; subagent session ${spawnedSessionKey} may be live or orphaned. Run "${formatCliCommand(`openclaw sessions delete --key ${spawnedSessionKey}`)}" once the run is known to be finished.`,
      );
    }
    throw err;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, response);
    return response;
  }

  const result = response?.result;
  const payloads = result?.payloads ?? [];

  if (payloads.length === 0) {
    runtime.log(response?.summary ? response.summary : "No reply from agent.");
    return response;
  }

  for (const payload of payloads) {
    const out = formatPayloadForLog(payload);
    if (out) {
      runtime.log(out);
    }
  }

  return response;
}

/**
 * Return explicit operator scopes for a --spawn gateway call.  Admin-only
 * methods (e.g. `sessions.patch`) are pinned to ADMIN_SCOPE; other methods
 * keep their least-privilege scope so the subagent leaf session does not
 * inherit owner (admin) privileges on the agent RPC.  Mirrors the pattern in
 * src/agents/subagent-spawn.ts so paired/headless gateways don't trigger a
 * scope-upgrade handshake between the sessions.patch and agent calls.
 */
function resolveSpawnScopes(method: string): OperatorScope[] {
  if (isAdminOnlyMethod(method)) {
    return [ADMIN_SCOPE];
  }
  // "agent" maps to the write scope; return it explicitly instead of
  // relying on least-privilege resolution so the scope stays stable even
  // if method-scope mappings evolve.
  return [WRITE_SCOPE];
}

export async function agentCliCommand(opts: AgentCliOpts, runtime: RuntimeEnv, deps?: CliDeps) {
  if (opts.local === true && opts.spawn === true) {
    // --spawn is implemented on the gateway path (pre-patching a subagent
    // session key). The embedded/local path would need its own isolated
    // session handling, so reject the combination instead of silently
    // reusing the main session and breaking the isolation contract.
    throw new Error(
      "--spawn cannot be combined with --local; use the gateway path for isolated subagent runs",
    );
  }
  const localOpts = {
    ...opts,
    agentId: opts.agent,
    replyAccountId: opts.replyAccount,
    cleanupBundleMcpOnRunEnd: opts.local === true,
  };
  if (opts.local === true) {
    return await agentCommand(localOpts, runtime, deps);
  }

  try {
    return await agentViaGatewayCommand(opts, runtime);
  } catch (err) {
    if (opts.spawn === true) {
      // The embedded fallback does not implement subagent isolation, so
      // silently falling back would violate the contract advertised by
      // --spawn. Re-throw so the caller sees the real failure.
      throw err;
    }
    runtime.error?.(`Gateway agent failed; falling back to embedded: ${String(err)}`);
    return await agentCommand(localOpts, runtime, deps);
  }
}
