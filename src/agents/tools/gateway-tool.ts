import { Type } from "@sinclair/typebox";
import { isRestartEnabled } from "../../config/commands.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveConfigSnapshotHash } from "../../config/io.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions, resolveGatewayTarget } from "./gateway.js";

const log = createSubsystemLogger("gateway-tool");

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: typeof hashValue === "string" ? hashValue : undefined,
    raw: typeof rawValue === "string" ? rawValue : undefined,
  });
  return hash ?? undefined;
}

const GATEWAY_ACTIONS = [
  "restart",
  "config.get",
  "config.schema.lookup",
  "config.apply",
  "config.patch",
  "update.run",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  // config.get, config.schema.lookup, config.apply, update.run
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // config.schema.lookup
  path: Type.Optional(Type.String()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  // config.apply, config.patch, update.run
  sessionKey: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Number()),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentAccountId?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    ownerOnly: true,
    description:
      "Restart, inspect a specific config schema path, apply config, or update the gateway in-place (SIGUSR1). Use config.schema.lookup with a targeted dot path before config edits. Use config.patch for safe partial config updates (merges with existing). Use config.apply only when replacing entire config. Both trigger restart after writing. Always pass a human-readable completion message via the `note` parameter so the system can deliver it to the user after restart.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "restart") {
        if (!isRestartEnabled(opts?.config)) {
          throw new Error("Gateway restart is disabled (commands.restart=false).");
        }
        const explicitSessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : undefined;
        const sessionKey = (explicitSessionKey ?? opts?.agentSessionKey?.trim()) || undefined;
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason =
          typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim().slice(0, 200)
            : undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        // Prefer the live delivery context captured during the current agent
        // run over extractDeliveryInfo() (which reads the persisted session
        // store). The session store is frequently overwritten by heartbeat
        // runs to { channel: "webchat", to: "heartbeat" }, causing the
        // sentinel to write stale routing data that fails post-restart.
        // See #18612.
        //
        // Only apply the live context when the restart targets this agent's
        // own session. When an explicit sessionKey points to a different
        // session, the live context belongs to the wrong session and would
        // misroute the post-restart reply. Fall back to extractDeliveryInfo()
        // so the server uses the correct routing for the target session.
        // Canonicalize both keys before comparing so that aliases like "main"
        // and "agent:main:main" are treated as the same session. Without this,
        // an operator passing sessionKey="main" would be incorrectly treated as
        // targeting a different session, suppressing live deliveryContext and
        // falling back to the stale session store. See #18612.
        const ownKey = opts?.agentSessionKey?.trim() || undefined;
        const agentId = resolveAgentIdFromSessionKey(ownKey);
        // Canonicalize each key using its OWN agentId — not the current session's.
        // If a non-default agent passes sessionKey="main", resolveAgentIdFromSessionKey
        // returns DEFAULT_AGENT_ID ("main") so "main" → "agent:main:main". Using the
        // current session's agentId instead would map "main" to the current agent's main
        // session, falsely treating a cross-agent request as same-session. See #18612.
        const canonicalizeOwn = (k: string) =>
          canonicalizeMainSessionAlias({ cfg: opts?.config, agentId, sessionKey: k });
        const canonicalizeTarget = (k: string) =>
          canonicalizeMainSessionAlias({
            cfg: opts?.config,
            agentId: resolveAgentIdFromSessionKey(k),
            sessionKey: k,
          });
        const isTargetingOtherSession =
          explicitSessionKey != null &&
          canonicalizeTarget(explicitSessionKey) !== (ownKey ? canonicalizeOwn(ownKey) : undefined);
        // Only forward live context when both channel and to are present.
        // Forwarding a partial context (channel without to) causes the server
        // to write a sentinel without `to`, and scheduleRestartSentinelWake
        // bails on `if (!channel || !to)`, silently degrading to a system
        // event with no delivery/resume. See #18612.
        const liveContext =
          !isTargetingOtherSession &&
          opts?.agentChannel != null &&
          String(opts.agentChannel).trim() &&
          opts?.agentTo != null &&
          String(opts.agentTo).trim()
            ? {
                channel: String(opts.agentChannel).trim(),
                to: String(opts.agentTo).trim(),
                accountId: opts?.agentAccountId ?? undefined,
              }
            : undefined;
        const extracted = extractDeliveryInfo(sessionKey);
        const deliveryContext =
          liveContext != null
            ? {
                ...liveContext,
                accountId: liveContext.accountId ?? extracted.deliveryContext?.accountId,
              }
            : extracted.deliveryContext;
        // Guard threadId with the same session check as deliveryContext. When
        // targeting another session, opts.agentThreadId belongs to the current
        // session's thread and must not be written into the sentinel — it would
        // cause scheduleRestartSentinelWake to deliver to the wrong thread.
        const threadId =
          !isTargetingOtherSession && opts?.agentThreadId != null
            ? String(opts.agentThreadId)
            : extracted.threadId;
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
          },
        };
        try {
          await writeRestartSentinel(payload);
        } catch {
          // ignore: sentinel is best-effort
        }
        log.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayOpts = readGatewayCallOptions(params);

      // Build the live delivery context from the current agent run's routing
      // fields. This is passed to server-side handlers so they can write an
      // accurate sentinel without reading the (potentially stale) session
      // store. The store is frequently overwritten by heartbeat runs to
      // { channel: "webchat", to: "heartbeat" }. See #18612.
      //
      // Note: agentThreadId is intentionally excluded here. threadId is
      // reliably derived server-side from the session key (via
      // parseSessionThreadInfo), which encodes it as :thread:N or :topic:N.
      // That parsing is not subject to heartbeat contamination, so there is
      // no need to forward it through the RPC params.
      // Only forward live context when both channel and to are present.
      // Forwarding a partial context (channel without to) causes the server
      // to prefer an incomplete deliveryContext over extractDeliveryInfo(),
      // writing a sentinel without `to` that scheduleRestartSentinelWake
      // rejects, silently degrading to a system event. See #18612.
      //
      // threadId is included so the server can use it for sessions where the
      // session key is not :thread:-scoped (e.g. Slack replyToMode="all"), in
      // which case the session-key-derived threadId would be empty.
      const liveDeliveryContextForRpc =
        opts?.agentChannel != null &&
        String(opts.agentChannel).trim() &&
        opts?.agentTo != null &&
        String(opts.agentTo).trim()
          ? {
              channel: String(opts.agentChannel).trim(),
              to: String(opts.agentTo).trim(),
              accountId: opts?.agentAccountId ?? undefined,
              threadId: opts?.agentThreadId != null ? String(opts.agentThreadId) : undefined,
            }
          : undefined;

      const resolveGatewayWriteMeta = (): {
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
        deliveryContext: typeof liveDeliveryContextForRpc;
      } => {
        const explicitSessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : undefined;
        const sessionKey = (explicitSessionKey ?? opts?.agentSessionKey?.trim()) || undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        // Only forward live context when the target session is this agent's
        // own session. Canonicalize both keys before comparing so that aliases
        // like "main" and "agent:main:main" are treated as the same session.
        // When an explicit sessionKey points to a different session, omit
        // deliveryContext so the server falls back to extractDeliveryInfo(sessionKey).
        const rpcOwnKey = opts?.agentSessionKey?.trim() || undefined;
        const rpcAgentId = resolveAgentIdFromSessionKey(rpcOwnKey);
        // Same cross-agent alias fix as the restart path: derive agentId from each key
        // independently so that "main" resolves to the default agent, not the current one.
        const rpcCanonicalizeOwn = (k: string) =>
          canonicalizeMainSessionAlias({ cfg: opts?.config, agentId: rpcAgentId, sessionKey: k });
        const rpcCanonicalizeTarget = (k: string) =>
          canonicalizeMainSessionAlias({
            cfg: opts?.config,
            agentId: resolveAgentIdFromSessionKey(k),
            sessionKey: k,
          });
        const isTargetingOtherSession =
          explicitSessionKey != null &&
          rpcCanonicalizeTarget(explicitSessionKey) !==
            (rpcOwnKey ? rpcCanonicalizeOwn(rpcOwnKey) : undefined);
        // Also omit when the call targets a remote gateway. The remote server's
        // extractDeliveryInfo(sessionKey) is the authoritative source for that
        // session's delivery route. Forwarding the local agent run's deliveryContext
        // would write a sentinel with the wrong chat destination on the remote host,
        // causing post-restart wake messages to be sent to the caller's chat instead
        // of the session on the remote gateway. See #18612.
        // Only suppress deliveryContext for truly remote gateways. A gatewayUrl
        // override pointing to a local loopback address (127.0.0.1, localhost,
        // [::1]) is still the local server and should forward context normally;
        // treating it as remote would fall back to extractDeliveryInfo(sessionKey)
        // and reintroduce the stale heartbeat routing this patch was meant to fix.
        const isRemoteGateway = resolveGatewayTarget(gatewayOpts) === "remote";
        const deliveryContext =
          isTargetingOtherSession || isRemoteGateway ? undefined : liveDeliveryContextForRpc;
        return { sessionKey, note, restartDelayMs, deliveryContext };
      };

      const resolveConfigWriteParams = async (): Promise<{
        raw: string;
        baseHash: string;
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
        deliveryContext: typeof liveDeliveryContextForRpc;
      }> => {
        const raw = readStringParam(params, "raw", { required: true });
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        if (!baseHash) {
          throw new Error("Missing baseHash from config snapshot.");
        }
        return { raw, baseHash, ...resolveGatewayWriteMeta() };
      };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema.lookup") {
        const path = readStringParam(params, "path", {
          required: true,
          label: "path",
        });
        const result = await callGatewayTool("config.schema.lookup", gatewayOpts, { path });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        const { raw, baseHash, sessionKey, note, restartDelayMs, deliveryContext } =
          await resolveConfigWriteParams();
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
          deliveryContext,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.patch") {
        const { raw, baseHash, sessionKey, note, restartDelayMs, deliveryContext } =
          await resolveConfigWriteParams();
        const result = await callGatewayTool("config.patch", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
          deliveryContext,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "update.run") {
        const { sessionKey, note, restartDelayMs, deliveryContext } = resolveGatewayWriteMeta();
        const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: updateTimeoutMs,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          restartDelayMs,
          deliveryContext,
          timeoutMs: updateTimeoutMs,
        });
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
