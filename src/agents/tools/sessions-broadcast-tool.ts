import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  classifySessionKind,
  deriveChannel,
  resolveDisplaySessionKey,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  type SessionListRow,
} from "./sessions-helpers.js";

const SessionsBroadcastToolSchema = Type.Object({
  message: Type.String(),
  scope: Type.Optional(Type.String()),
});

export function createSessionsBroadcastTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Sessions Broadcast",
    name: "sessions_broadcast",
    description:
      "Broadcast a system event to all active sessions. Use scope to target a specific channel (e.g. 'discord'), or omit (or use 'all') for all sessions.",
    parameters: SessionsBroadcastToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message", { required: true });
      const scopeRaw = readStringParam(params, "scope")?.trim().toLowerCase() || "all";

      const cfg = opts?.config ?? loadConfig();
      const { mainKey, alias, requesterInternalKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const effectiveRequesterKey = requesterInternalKey ?? alias;

      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const a2aPolicy = createAgentToAgentPolicy(cfg);

      // Fetch all sessions via gateway
      const list = await callGateway<{ sessions: Array<SessionListRow> }>({
        method: "sessions.list",
        params: {
          includeGlobal: !restrictToSpawned,
          includeUnknown: !restrictToSpawned,
          spawnedBy: restrictToSpawned ? effectiveRequesterKey : undefined,
        },
      });

      const sessions = Array.isArray(list?.sessions) ? list.sessions : [];

      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });

      // Build list of target sessions, filtering out self and applying scope
      const targets: Array<{ internalKey: string; displayKey: string }> = [];

      for (const entry of sessions) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const key = typeof entry.key === "string" ? entry.key : "";
        if (!key || key === "unknown" || key === "global") {
          continue;
        }

        // Skip self
        if (key === effectiveRequesterKey) {
          continue;
        }

        // Visibility check
        const access = visibilityGuard.check(key);
        if (!access.allowed) {
          continue;
        }

        // Derive display key (collapses alias/mainKey to "main")
        const displayKey = resolveDisplaySessionKey({ key, alias, mainKey });

        // Derive channel for scope filtering
        const gatewayKind = typeof entry.kind === "string" ? entry.kind : undefined;
        const kind = classifySessionKind({ key, gatewayKind, alias, mainKey });
        const entryChannel = typeof entry.channel === "string" ? entry.channel : undefined;
        const lastChannel = typeof entry.lastChannel === "string" ? entry.lastChannel : undefined;
        const channel = deriveChannel({ key, kind, channel: entryChannel, lastChannel });

        // Apply scope filter
        if (scopeRaw !== "all" && channel !== scopeRaw) {
          continue;
        }

        targets.push({ internalKey: key, displayKey });
      }

      if (targets.length === 0) {
        return jsonResult({
          status: "ok",
          sent: 0,
          sessions: [],
          message: "No sessions to broadcast to.",
        });
      }

      // Fire-and-forget: inject system event into each target session
      const sentKeys: string[] = [];
      const errors: Array<{ key: string; error: string }> = [];

      for (const { internalKey, displayKey } of targets) {
        try {
          void callGateway({
            method: "agent",
            params: {
              message,
              sessionKey: internalKey,
              idempotencyKey: crypto.randomUUID(),
              deliver: false,
              channel: INTERNAL_MESSAGE_CHANNEL,
              lane: AGENT_LANE_NESTED,
              inputProvenance: {
                kind: "broadcast",
                sourceSessionKey: opts?.agentSessionKey,
                sourceChannel: opts?.agentChannel,
                sourceTool: "sessions_broadcast",
              },
            },
            timeoutMs: 10_000,
          });
          sentKeys.push(displayKey);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ key: displayKey, error: msg });
        }
      }

      return jsonResult({
        status: "ok",
        sent: sentKeys.length,
        sessions: sentKeys,
        ...(errors.length > 0 ? { errors } : {}),
      });
    },
  };
}
