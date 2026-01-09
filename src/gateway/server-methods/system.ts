import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { getLastHeartbeatEvent } from "../../infra/heartbeat-events.js";
import { setHeartbeatsEnabled } from "../../infra/heartbeat-runner.js";
import {
  enqueueSystemEvent,
  isSystemEventContextChanged,
} from "../../infra/system-events.js";
import {
  listSystemPresence,
  updateSystemPresence,
} from "../../infra/system-presence.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const systemHandlers: GatewayRequestHandlers = {
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
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "text required"),
      );
      return;
    }
    const sessionKey = resolveMainSessionKeyFromConfig();
    const instanceId =
      typeof params.instanceId === "string" ? params.instanceId : undefined;
    const host = typeof params.host === "string" ? params.host : undefined;
    const ip = typeof params.ip === "string" ? params.ip : undefined;
    const mode = typeof params.mode === "string" ? params.mode : undefined;
    const version =
      typeof params.version === "string" ? params.version : undefined;
    const platform =
      typeof params.platform === "string" ? params.platform : undefined;
    const deviceFamily =
      typeof params.deviceFamily === "string" ? params.deviceFamily : undefined;
    const modelIdentifier =
      typeof params.modelIdentifier === "string"
        ? params.modelIdentifier
        : undefined;
    const lastInputSeconds =
      typeof params.lastInputSeconds === "number" &&
      Number.isFinite(params.lastInputSeconds)
        ? params.lastInputSeconds
        : undefined;
    const reason =
      typeof params.reason === "string" ? params.reason : undefined;
    const tags =
      Array.isArray(params.tags) &&
      params.tags.every((t) => typeof t === "string")
        ? (params.tags as string[])
        : undefined;
    const presenceUpdate = updateSystemPresence({
      text,
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
      tags,
    });
    const isNodePresenceLine = text.startsWith("Node:");
    if (isNodePresenceLine) {
      const next = presenceUpdate.next;
      const changed = new Set(presenceUpdate.changedKeys);
      const reasonValue = next.reason ?? reason;
      const normalizedReason = (reasonValue ?? "").toLowerCase();
      const ignoreReason =
        normalizedReason.startsWith("periodic") ||
        normalizedReason === "heartbeat";
      const hostChanged = changed.has("host");
      const ipChanged = changed.has("ip");
      const versionChanged = changed.has("version");
      const modeChanged = changed.has("mode");
      const reasonChanged = changed.has("reason") && !ignoreReason;
      const hasChanges =
        hostChanged ||
        ipChanged ||
        versionChanged ||
        modeChanged ||
        reasonChanged;
      if (hasChanges) {
        const contextChanged = isSystemEventContextChanged(
          sessionKey,
          presenceUpdate.key,
        );
        const parts: string[] = [];
        if (contextChanged || hostChanged || ipChanged) {
          const hostLabel = next.host?.trim() || "Unknown";
          const ipLabel = next.ip?.trim();
          parts.push(`Node: ${hostLabel}${ipLabel ? ` (${ipLabel})` : ""}`);
        }
        if (versionChanged) {
          parts.push(`app ${next.version?.trim() || "unknown"}`);
        }
        if (modeChanged) {
          parts.push(`mode ${next.mode?.trim() || "unknown"}`);
        }
        if (reasonChanged) {
          parts.push(`reason ${reasonValue?.trim() || "event"}`);
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
    const nextPresenceVersion = context.incrementPresenceVersion();
    context.broadcast(
      "presence",
      { presence: listSystemPresence() },
      {
        dropIfSlow: true,
        stateVersion: {
          presence: nextPresenceVersion,
          health: context.getHealthVersion(),
        },
      },
    );
    respond(true, { ok: true }, undefined);
  },
};
