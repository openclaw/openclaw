/**
 * Status Updates Integration
 *
 * Integrates the status update controller with the agent runner
 * and provides helpers for resolving configuration from the config.
 */

import type { ClawdbotConfig } from "../../config/config.js";
import type { StatusUpdateConfig } from "../../config/types.base.js";
import type { ChannelCapabilities } from "../../channels/plugins/types.core.js";
import {
  createStatusUpdateController,
  type StatusPhase,
  type StatusUpdateCallbacks,
  type StatusUpdateController,
} from "./status-updates.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("status-updates-integration");

/**
 * Resolve status update configuration from the Clawdbot config.
 */
export function resolveStatusUpdateConfigFromConfig(
  cfg: ClawdbotConfig,
  agentId?: string,
): StatusUpdateConfig {
  log.debug(`Resolving status update config for agentId=${agentId}`);

  // Check agent-specific config first
  if (agentId && cfg.agents?.list) {
    const agentCfg = cfg.agents.list.find((a) => a.id === agentId);
    if (agentCfg?.statusUpdates) {
      log.debug(`Found agent-specific config: ${JSON.stringify(agentCfg.statusUpdates)}`);
      return agentCfg.statusUpdates;
    }
  }

  // Fall back to agent defaults
  const defaultConfig = cfg.agents?.defaults?.statusUpdates ?? {};
  log.debug(`Using default config: ${JSON.stringify(defaultConfig)}`);
  return defaultConfig;
}

/**
 * Check if a channel supports message editing.
 */
export function channelSupportsEdit(capabilities?: ChannelCapabilities): boolean {
  return capabilities?.edit === true;
}

/**
 * Create a status update controller for an agent run.
 * Returns undefined if status updates are disabled.
 */
export function createAgentStatusController(params: {
  cfg: ClawdbotConfig;
  agentId?: string;
  callbacks: StatusUpdateCallbacks;
}): StatusUpdateController | undefined {
  const { cfg, agentId, callbacks } = params;
  log.info(`createAgentStatusController called for agentId=${agentId}`);

  const config = resolveStatusUpdateConfigFromConfig(cfg, agentId);

  if (!config.enabled) {
    log.info(`Status updates disabled (enabled=${config.enabled})`);
    return undefined;
  }

  log.info(
    `Creating status update controller with mode=${config.mode}, supportsEdit=${callbacks.supportsEdit?.()}`,
  );
  const controller = createStatusUpdateController(config, callbacks);
  log.info(`Status update controller created successfully`);
  return controller;
}

/**
 * Map agent lifecycle events to status phases.
 */
export function mapAgentEventToPhase(event: {
  stream: string;
  data: Record<string, unknown>;
}): StatusPhase | undefined {
  const { stream, data } = event;
  const phase = typeof data.phase === "string" ? data.phase : "";

  if (stream === "lifecycle") {
    if (phase === "start") return "sending_query";
    if (phase === "end") return "complete";
  }

  if (stream === "tool") {
    if (phase === "start") return "processing_tools";
  }

  if (stream === "thinking" || stream === "reasoning") {
    return "receiving_reasoning";
  }

  if (stream === "message") {
    if (phase === "start") return "generating_response";
  }

  return undefined;
}

/**
 * Context for status updates within an agent run.
 */
export type StatusUpdateRunContext = {
  controller?: StatusUpdateController;
  startedAt: number;
  currentPhase: StatusPhase;
};

/**
 * Create a run context for status updates.
 */
export function createStatusUpdateRunContext(
  controller?: StatusUpdateController,
): StatusUpdateRunContext {
  log.info(`createStatusUpdateRunContext: controller=${controller ? "present" : "undefined"}`);

  const ctx = {
    controller,
    startedAt: Date.now(),
    currentPhase: "sending_query" as StatusPhase,
  };

  if (controller) {
    log.info(`Status update context created with controller, starting...`);
    // Start the controller asynchronously
    controller.start().catch((err) => {
      log.debug(`Failed to start status controller: ${String(err)}`);
    });
  } else {
    log.info(`Status update context created WITHOUT controller (status updates disabled)`);
  }

  return ctx;
}

/**
 * Handle an agent event and update the status phase if applicable.
 */
export async function handleAgentEventForStatus(
  ctx: StatusUpdateRunContext,
  event: { stream: string; data: Record<string, unknown> },
): Promise<void> {
  if (!ctx.controller) {
    log.debug(`handleAgentEventForStatus: no controller, skipping event stream=${event.stream}`);
    return;
  }

  const phase = mapAgentEventToPhase(event);
  log.debug(
    `handleAgentEventForStatus: stream=${event.stream}, phase=${event.data.phase}, mappedPhase=${phase}, currentPhase=${ctx.currentPhase}`,
  );

  if (phase && phase !== ctx.currentPhase) {
    log.info(`Status phase change: ${ctx.currentPhase} -> ${phase}`);
    ctx.currentPhase = phase;
    await ctx.controller.setPhase(phase);
  }
}

/**
 * Mark the status as complete and optionally add checkmark to final text.
 */
export async function completeStatusUpdate(
  ctx: StatusUpdateRunContext,
  finalText?: string,
): Promise<string | undefined> {
  if (!ctx.controller) {
    log.debug(`completeStatusUpdate: no controller, returning original text`);
    return finalText;
  }

  log.info(`completeStatusUpdate: finalizing status update`);
  const result = await ctx.controller.complete(finalText);
  log.debug(`completeStatusUpdate: result=${result?.substring(0, 50)}...`);
  return result;
}

/**
 * Cleanup the status update controller.
 */
export async function cleanupStatusUpdate(ctx: StatusUpdateRunContext): Promise<void> {
  if (!ctx.controller) return;
  await ctx.controller.cleanup();
}

/**
 * Export a no-op callbacks object for channels that don't support status updates.
 */
export const noopStatusCallbacks: StatusUpdateCallbacks = {
  sendStatus: async () => undefined,
  supportsEdit: () => false,
};
