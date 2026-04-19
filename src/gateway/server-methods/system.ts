import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/io.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { getLastHeartbeatEvent } from "../../infra/heartbeat-events.js";
import { runHeartbeatOnce, setHeartbeatsEnabled } from "../../infra/heartbeat-runner.js";
import { enqueueSystemEvent, isSystemEventContextChanged } from "../../infra/system-events.js";
import { listSystemPresence, updateSystemPresence } from "../../infra/system-presence.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { broadcastPresenceSnapshot } from "../server/presence-events.js";
import type { GatewayRequestHandlers } from "./types.js";

export const systemHandlers: GatewayRequestHandlers = {
  "gateway.identity.get": ({ respond }) => {
    const identity = loadOrCreateDeviceIdentity();
    respond(
      true,
      {
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      },
      undefined,
    );
  },
  "last-heartbeat": ({ respond }) => {
    respond(true, getLastHeartbeatEvent(), undefined);
  },
  "set-heartbeats": ({ params, respond }) => {
    const enabled = params.enabled;
    if (typeof enabled !== "boolean") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid set-heartbeats params: enabled (boolean) required",
        ),
      );
      return;
    }
    setHeartbeatsEnabled(enabled);
    respond(true, { ok: true, enabled }, undefined);
  },
  "system-presence": ({ respond }) => {
    const presence = listSystemPresence();
    respond(true, presence, undefined);
  },
  "system-event": ({ params, respond, context }) => {
    const text = normalizeOptionalString(params.text) ?? "";
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "text required"));
      return;
    }
    const sessionKey = resolveMainSessionKeyFromConfig();
    const deviceId = readStringValue(params.deviceId);
    const instanceId = readStringValue(params.instanceId);
    const host = readStringValue(params.host);
    const ip = readStringValue(params.ip);
    const mode = readStringValue(params.mode);
    const version = readStringValue(params.version);
    const platform = readStringValue(params.platform);
    const deviceFamily = readStringValue(params.deviceFamily);
    const modelIdentifier = readStringValue(params.modelIdentifier);
    const lastInputSeconds =
      typeof params.lastInputSeconds === "number" && Number.isFinite(params.lastInputSeconds)
        ? params.lastInputSeconds
        : undefined;
    const reason = readStringValue(params.reason);
    const roles =
      Array.isArray(params.roles) && params.roles.every((t) => typeof t === "string")
        ? params.roles
        : undefined;
    const scopes =
      Array.isArray(params.scopes) && params.scopes.every((t) => typeof t === "string")
        ? params.scopes
        : undefined;
    const tags =
      Array.isArray(params.tags) && params.tags.every((t) => typeof t === "string")
        ? params.tags
        : undefined;
    const presenceUpdate = updateSystemPresence({
      text,
      deviceId,
      instanceId,
      host,
      ip,
      mode,
      version,
      platform,
      deviceFamily,
      modelIdentifier,
      lastInputSeconds,
      reason,
      roles,
      scopes,
      tags,
    });
    const isNodePresenceLine = text.startsWith("Node:");
    if (isNodePresenceLine) {
      const next = presenceUpdate.next;
      const changed = new Set(presenceUpdate.changedKeys);
      const reasonValue = next.reason ?? reason;
      const normalizedReason = normalizeLowercaseStringOrEmpty(reasonValue);
      const ignoreReason =
        normalizedReason.startsWith("periodic") || normalizedReason === "heartbeat";
      const hostChanged = changed.has("host");
      const ipChanged = changed.has("ip");
      const versionChanged = changed.has("version");
      const modeChanged = changed.has("mode");
      const reasonChanged = changed.has("reason") && !ignoreReason;
      const hasChanges = hostChanged || ipChanged || versionChanged || modeChanged || reasonChanged;
      if (hasChanges) {
        const contextChanged = isSystemEventContextChanged(sessionKey, presenceUpdate.key);
        const parts: string[] = [];
        if (contextChanged || hostChanged || ipChanged) {
          const hostLabel = normalizeOptionalString(next.host) ?? "Unknown";
          const ipLabel = normalizeOptionalString(next.ip);
          parts.push(`Node: ${hostLabel}${ipLabel ? ` (${ipLabel})` : ""}`);
        }
        if (versionChanged) {
          parts.push(`app ${normalizeOptionalString(next.version) ?? "unknown"}`);
        }
        if (modeChanged) {
          parts.push(`mode ${normalizeOptionalString(next.mode) ?? "unknown"}`);
        }
        if (reasonChanged) {
          parts.push(`reason ${normalizeOptionalString(reasonValue) ?? "event"}`);
        }
        const deltaText = parts.join(" · ");
        if (deltaText) {
          enqueueSystemEvent(deltaText, {
            sessionKey,
            contextKey: presenceUpdate.key,
          });
        }
      }
    } else {
      enqueueSystemEvent(text, { sessionKey });
    }
    broadcastPresenceSnapshot({
      broadcast: context.broadcast,
      incrementPresenceVersion: context.incrementPresenceVersion,
      getHealthVersion: context.getHealthVersion,
    });
    respond(true, { ok: true }, undefined);
  },
  "heartbeat.trigger": async ({ params, respond }) => {
    const agentId = normalizeOptionalString(params.agentId);
    const sessionKey = normalizeOptionalString(params.sessionKey);
    const reason = normalizeOptionalString(params.reason) ?? "interval";

    const cfg = loadConfig();
    // Resolve heartbeat config the same way runHeartbeatOnce would, then inject
    // a synthetic interval so it doesn't skip at the intervalMs gate.
    // Real scheduling is owned by Paperclip — this just unblocks the gate.
    const defaults = cfg.agents?.defaults?.heartbeat;
    const agentList = cfg.agents?.list ?? [];
    const agentEntry = agentId ? agentList.find((e) => e?.id === agentId) : undefined;
    const overrides = agentEntry?.heartbeat;

    const heartbeat = {
      ...defaults,
      ...(typeof overrides === "object" && overrides !== null ? overrides : {}),
      every: "60m",
    };

    // Write Paperclip API context to the agent workspace so the agent can
    // read it during heartbeat task execution. HEARTBEAT.md directives tell
    // the agent to load this file for API credentials.
    const pctx =
      typeof params.paperclipContext === "object" && params.paperclipContext !== null
        ? (params.paperclipContext as Record<string, unknown>)
        : null;
    if (pctx) {
      const resolvedAgentId = agentId || undefined;
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolvedAgentId);
      try {
        await fs.writeFile(
          path.join(workspaceDir, "paperclip-run-context.json"),
          JSON.stringify(pctx, null, 2),
        );
      } catch {
        // Non-fatal — agent can still run tasks that don't need Paperclip API
      }
    }

    try {
      const result = await runHeartbeatOnce({
        cfg,
        agentId: agentId || undefined,
        sessionKey: sessionKey || undefined,
        heartbeat,
        reason,
      });
      respond(true, result, undefined);
    } catch (err: unknown) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `heartbeat trigger failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};
