/**
 * Workspace Events Bridge
 *
 * Transforms gws events +subscribe NDJSON output (CloudEvent JSON)
 * into the hook payload format expected by the workspace-events preset.
 */

import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";

export type WsEventsHookEvent = {
  type: string;
  source: string;
  time: string;
  resourceType: string;
  summary: string;
  data: Record<string, unknown>;
};

export type WsEventsHookPayload = {
  events: WsEventsHookEvent[];
};

/**
 * Extract a human-readable resource type from the event type string.
 * e.g. "google.workspace.chat.message.v1.created" → "chat.message"
 */
export function extractResourceType(eventType: string): string {
  const stripped = eventType.replace(/^google\.workspace\./, "");
  const withoutVersion = stripped.replace(/\.v\d+\.\w+$/, "");
  return withoutVersion || eventType;
}

/**
 * Build a human-readable summary from a CloudEvent.
 */
export function buildEventSummary(eventType: string, source: string): string {
  const action = eventType.split(".").pop() ?? "unknown";
  const resource = extractResourceType(eventType);
  return `${resource} ${action} from ${source}`;
}

/**
 * Transform a raw CloudEvent object (from gws events +subscribe) into
 * the hook payload format expected by the workspace-events preset.
 */
export function transformCloudEvent(event: Record<string, unknown>): WsEventsHookPayload {
  const type = typeof event.type === "string" ? event.type : "";
  const source = typeof event.source === "string" ? event.source : "";
  const time = typeof event.time === "string" ? event.time : "";
  const data =
    event.data !== null && typeof event.data === "object" && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {};

  return {
    events: [
      {
        type,
        source,
        time,
        resourceType: extractResourceType(type),
        summary: buildEventSummary(type, source),
        data,
      },
    ],
  };
}

/**
 * POST a hook payload to the OpenClaw hook URL.
 */
async function postToHookUrl(
  payload: WsEventsHookPayload,
  hookUrl: string,
  hookToken: string,
): Promise<void> {
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hookToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Hook POST failed: ${response.status} ${response.statusText}`);
  }
}

export type WsEventsNdjsonLineHandlerConfig = {
  hookUrl: string;
  hookToken: string;
};

/**
 * Create a callback that processes a single NDJSON line from gws stdout,
 * transforms it into a hook payload, and POSTs it.
 */
export function createWsEventsNdjsonLineHandler(
  cfg: WsEventsNdjsonLineHandlerConfig,
  log?: SubsystemLogger,
): (line: string) => void {
  const logger = log ?? createSubsystemLogger("ws-events-bridge");

  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      logger.warn(`ignoring non-JSON line: ${trimmed.slice(0, 120)}`);
      return;
    }

    const payload = transformCloudEvent(event);

    const eventType = payload.events[0]?.type ?? "?";
    logger.info(`forwarding event ${eventType} to ${cfg.hookUrl}`);

    void postToHookUrl(payload, cfg.hookUrl, cfg.hookToken).catch((err) => {
      logger.error(`failed to forward event ${eventType}: ${String(err)}`);
    });
  };
}
