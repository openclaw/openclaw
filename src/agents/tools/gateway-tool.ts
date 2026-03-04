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
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

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
        const isTargetingOtherSession =
          explicitSessionKey != null &&
          explicitSessionKey !== (opts?.agentSessionKey?.trim() || undefined);
        const liveContext =
          !isTargetingOtherSession && opts?.agentChannel != null && String(opts.agentChannel).trim()
            ? {
                channel: String(opts.agentChannel).trim(),
                to: opts?.agentTo ?? undefined,
                accountId: opts?.agentAccountId ?? undefined,
              }
            : undefined;
        const extracted = extractDeliveryInfo(sessionKey);
        const deliveryContext = liveContext ?? extracted.deliveryContext;
        const threadId =
          opts?.agentThreadId != null ? String(opts.agentThreadId) : extracted.threadId;
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
      const liveDeliveryContextForRpc =
        opts?.agentChannel != null && String(opts.agentChannel).trim()
          ? {
              channel: String(opts.agentChannel).trim(),
              to: opts?.agentTo ?? undefined,
              accountId: opts?.agentAccountId ?? undefined,
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
        // own session. When an explicit sessionKey points to a different
        // session, omit deliveryContext so the server falls back to
        // extractDeliveryInfo(sessionKey) which uses that session's routing.
        const isTargetingOtherSession =
          explicitSessionKey != null &&
          explicitSessionKey !== (opts?.agentSessionKey?.trim() || undefined);
        const deliveryContext = isTargetingOtherSession ? undefined : liveDeliveryContextForRpc;
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
