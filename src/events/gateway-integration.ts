/**
 * Event Bus - Gateway Integration
 *
 * Bridges the gateway's existing event patterns to the unified event bus.
 * This module:
 * - Creates and configures the event bus for gateway use
 * - Bridges agent events, diagnostic events, etc. to the bus
 * - Provides typed emit helpers for common events
 * - Integrates with the gateway broadcast system
 */

import type { MoltbotConfig } from "../config/config.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { createEventBus, setEventBus, getEventBus } from "./bus.js";
import type { EventBus, EventBusConfig } from "./types.js";
import { createEventStore, getDefaultEventStorePath } from "./store.js";
import { createEvent, type EventTopicMap } from "./catalog.js";

// ============================================================================
// Gateway Event Bus Configuration
// ============================================================================

export type GatewayEventBusConfig = {
  /** Enable event persistence (default: false) */
  persistEvents?: boolean;
  /** Custom path for event store database */
  eventStorePath?: string;
  /** Max events to keep in store (default: 100000) */
  maxStoredEvents?: number;
  /** Logger */
  logger?: EventBusConfig["logger"];
};

export type GatewayEventBusHandle = {
  /** The event bus instance */
  bus: EventBus;
  /** Cleanup function - call on gateway shutdown */
  cleanup: () => void;
  /** Typed emit helpers */
  emit: GatewayEventEmitters;
};

// ============================================================================
// Typed Emit Helpers
// ============================================================================

/**
 * Typed event emitters for common gateway events
 */
export type GatewayEventEmitters = {
  // Channel events
  channelMessageReceived: (
    payload: EventTopicMap["channel.message.received"],
    opts?: { sessionKey?: string; correlationId?: string },
  ) => void;
  channelMessageSent: (
    payload: EventTopicMap["channel.message.sent"],
    opts?: { sessionKey?: string; correlationId?: string },
  ) => void;
  channelMessageFailed: (
    payload: EventTopicMap["channel.message.failed"],
    opts?: { sessionKey?: string; correlationId?: string },
  ) => void;
  channelStatusChanged: (payload: EventTopicMap["channel.status.changed"]) => void;

  // Agent events
  agentRunStarted: (
    payload: EventTopicMap["agent.run.started"],
    opts?: { sessionKey?: string; correlationId?: string },
  ) => void;
  agentRunCompleted: (
    payload: EventTopicMap["agent.run.completed"],
    opts?: { sessionKey?: string; correlationId?: string },
  ) => void;
  agentToolExecuting: (
    payload: EventTopicMap["agent.tool.executing"],
    opts?: { sessionKey?: string; correlationId?: string },
  ) => void;
  agentToolCompleted: (
    payload: EventTopicMap["agent.tool.completed"],
    opts?: { sessionKey?: string; correlationId?: string },
  ) => void;

  // System events
  gatewayStarted: (payload: EventTopicMap["gateway.started"]) => void;
  gatewayShuttingDown: (payload: EventTopicMap["gateway.shutting_down"]) => void;
  configReloaded: (payload: EventTopicMap["config.reloaded"]) => void;
  cronExecuted: (payload: EventTopicMap["cron.executed"]) => void;

  // Plugin events
  pluginLoaded: (payload: EventTopicMap["plugin.loaded"]) => void;
  pluginCustom: (payload: EventTopicMap["plugin.custom"], opts?: { sessionKey?: string }) => void;
  pluginError: (payload: EventTopicMap["plugin.error"]) => void;

  // Security events
  securityApprovalRequested: (
    payload: EventTopicMap["security.approval.requested"],
    opts?: { sessionKey?: string },
  ) => void;
  securityApprovalResolved: (
    payload: EventTopicMap["security.approval.resolved"],
    opts?: { sessionKey?: string },
  ) => void;

  // Webhook events
  webhookReceived: (payload: EventTopicMap["webhook.received"]) => void;
};

function createGatewayEventEmitters(bus: EventBus): GatewayEventEmitters {
  return {
    // Channel events
    channelMessageReceived: (payload, opts) =>
      bus.emit(
        createEvent("channel.message.received", payload, {
          source: `channel:${payload.channelId}`,
          ...opts,
        }),
      ),
    channelMessageSent: (payload, opts) =>
      bus.emit(
        createEvent("channel.message.sent", payload, {
          source: `channel:${payload.channelId}`,
          ...opts,
        }),
      ),
    channelMessageFailed: (payload, opts) =>
      bus.emit(
        createEvent("channel.message.failed", payload, {
          source: `channel:${payload.channelId}`,
          ...opts,
        }),
      ),
    channelStatusChanged: (payload) =>
      bus.emit(
        createEvent("channel.status.changed", payload, {
          source: `channel:${payload.channelId}`,
        }),
      ),

    // Agent events
    agentRunStarted: (payload, opts) =>
      bus.emit(
        createEvent("agent.run.started", payload, {
          source: `agent:${payload.agentId}`,
          correlationId: payload.runId,
          ...opts,
        }),
      ),
    agentRunCompleted: (payload, opts) =>
      bus.emit(
        createEvent("agent.run.completed", payload, {
          source: `agent:${payload.agentId}`,
          correlationId: payload.runId,
          ...opts,
        }),
      ),
    agentToolExecuting: (payload, opts) =>
      bus.emit(
        createEvent("agent.tool.executing", payload, {
          source: `agent:${payload.agentId}`,
          correlationId: payload.runId,
          ...opts,
        }),
      ),
    agentToolCompleted: (payload, opts) =>
      bus.emit(
        createEvent("agent.tool.completed", payload, {
          source: `agent:${payload.agentId}`,
          correlationId: payload.runId,
          ...opts,
        }),
      ),

    // System events
    gatewayStarted: (payload) =>
      bus.emit(createEvent("gateway.started", payload, { source: "gateway" })),
    gatewayShuttingDown: (payload) =>
      bus.emit(createEvent("gateway.shutting_down", payload, { source: "gateway" })),
    configReloaded: (payload) =>
      bus.emit(createEvent("config.reloaded", payload, { source: "gateway" })),
    cronExecuted: (payload) => bus.emit(createEvent("cron.executed", payload, { source: "cron" })),

    // Plugin events
    pluginLoaded: (payload) =>
      bus.emit(createEvent("plugin.loaded", payload, { source: `plugin:${payload.pluginId}` })),
    pluginCustom: (payload, opts) =>
      bus.emit(
        createEvent("plugin.custom", payload, {
          source: `plugin:${payload.pluginId}`,
          ...opts,
        }),
      ),
    pluginError: (payload) =>
      bus.emit(createEvent("plugin.error", payload, { source: `plugin:${payload.pluginId}` })),

    // Security events
    securityApprovalRequested: (payload, opts) =>
      bus.emit(
        createEvent("security.approval.requested", payload, {
          source: "security",
          ...opts,
        }),
      ),
    securityApprovalResolved: (payload, opts) =>
      bus.emit(
        createEvent("security.approval.resolved", payload, {
          source: "security",
          ...opts,
        }),
      ),

    // Webhook events
    webhookReceived: (payload) =>
      bus.emit(
        createEvent("webhook.received", payload, {
          source: `webhook:${payload.webhookId}`,
        }),
      ),
  };
}

// ============================================================================
// Agent Event Bridge
// ============================================================================

/**
 * Map agent event streams to event bus topics
 */
function bridgeAgentEvent(bus: EventBus, evt: AgentEventPayload): void {
  const { runId, sessionKey, data } = evt;

  // Extract common fields
  const agentId = (data.agentId as string) || "default";

  switch (evt.stream) {
    case "run.start":
      bus.emit(
        createEvent(
          "agent.run.started",
          {
            runId,
            agentId,
            model: (data.model as string) || "unknown",
            trigger:
              (data.trigger as "message" | "cron" | "webhook" | "command" | "internal") ||
              "internal",
            inputTokens: data.inputTokens as number | undefined,
          },
          {
            source: `agent:${agentId}`,
            sessionKey,
            correlationId: runId,
          },
        ),
      );
      break;

    case "run.complete":
      bus.emit(
        createEvent(
          "agent.run.completed",
          {
            runId,
            agentId,
            success: (data.success as boolean) ?? true,
            duration: (data.duration as number) || 0,
            inputTokens: (data.inputTokens as number) || 0,
            outputTokens: (data.outputTokens as number) || 0,
            toolCalls: (data.toolCalls as number) || 0,
            error: data.error as string | undefined,
          },
          {
            source: `agent:${agentId}`,
            sessionKey,
            correlationId: runId,
          },
        ),
      );
      break;

    case "tool.start":
      bus.emit(
        createEvent(
          "agent.tool.executing",
          {
            runId,
            agentId,
            toolName: (data.toolName as string) || "unknown",
            toolInput: (data.toolInput as Record<string, unknown>) || {},
          },
          {
            source: `agent:${agentId}`,
            sessionKey,
            correlationId: runId,
          },
        ),
      );
      break;

    case "tool.complete":
      bus.emit(
        createEvent(
          "agent.tool.completed",
          {
            runId,
            agentId,
            toolName: (data.toolName as string) || "unknown",
            success: (data.success as boolean) ?? true,
            duration: (data.duration as number) || 0,
            error: data.error as string | undefined,
          },
          {
            source: `agent:${agentId}`,
            sessionKey,
            correlationId: runId,
          },
        ),
      );
      break;

    case "text.delta":
      bus.emit(
        createEvent(
          "agent.text.chunk",
          {
            runId,
            agentId,
            chunk: (data.chunk as string) || "",
            accumulated: (data.accumulated as string) || "",
          },
          {
            source: `agent:${agentId}`,
            sessionKey,
            correlationId: runId,
          },
        ),
      );
      break;

    // Other streams can be added as needed
  }
}

// ============================================================================
// Diagnostic Event Bridge
// ============================================================================

/**
 * Bridge diagnostic events to the event bus
 */
function bridgeDiagnosticEvent(bus: EventBus, evt: DiagnosticEventPayload): void {
  // Map diagnostic events to appropriate bus topics
  // These are internal/debug events, so we emit them under a diagnostic namespace
  bus.emit({
    topic: `diagnostic.${evt.type}`,
    payload: evt,
    source: "diagnostic",
    sessionKey: "sessionKey" in evt ? (evt.sessionKey as string) : undefined,
  });
}

// ============================================================================
// Main Integration
// ============================================================================

/**
 * Initialize the gateway event bus
 *
 * Call this early in gateway startup to set up the event bus
 * and bridge existing event patterns.
 */
export function initGatewayEventBus(config: GatewayEventBusConfig = {}): GatewayEventBusHandle {
  const { persistEvents = false, eventStorePath, maxStoredEvents = 100_000, logger } = config;

  // Create event store if persistence enabled
  let store: ReturnType<typeof createEventStore> | undefined;
  if (persistEvents) {
    store = createEventStore({
      dbPath: eventStorePath ?? getDefaultEventStorePath(),
      maxEvents: maxStoredEvents,
      logger,
    });
  }

  // Create the event bus
  const bus = createEventBus({
    store,
    logger,
  });

  // Set as default bus
  setEventBus(bus);

  // Bridge existing agent events
  const agentUnsub = onAgentEvent((evt) => {
    try {
      bridgeAgentEvent(bus, evt);
    } catch {
      // Ignore bridging errors
    }
  });

  // Bridge diagnostic events
  const diagnosticUnsub = onDiagnosticEvent((evt) => {
    try {
      bridgeDiagnosticEvent(bus, evt);
    } catch {
      // Ignore bridging errors
    }
  });

  // Create typed emitters
  const emit = createGatewayEventEmitters(bus);

  // Cleanup function
  const cleanup = () => {
    agentUnsub();
    diagnosticUnsub();
    bus.shutdown();
    store?.close();
  };

  return { bus, cleanup, emit };
}

/**
 * Extract event bus config from moltbot config
 */
export function extractEventBusConfig(cfg: MoltbotConfig): GatewayEventBusConfig {
  const eventsCfg = (cfg as Record<string, unknown>).events as Record<string, unknown> | undefined;
  return {
    persistEvents: eventsCfg?.persist === true,
    eventStorePath: typeof eventsCfg?.storePath === "string" ? eventsCfg.storePath : undefined,
    maxStoredEvents: typeof eventsCfg?.maxEvents === "number" ? eventsCfg.maxEvents : undefined,
  };
}

// ============================================================================
// Re-export for Convenience
// ============================================================================

export { getEventBus } from "./bus.js";
export type { EventBus } from "./types.js";
