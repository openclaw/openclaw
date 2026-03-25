/**
 * Multi-Agent Transcript Hook
 *
 * Automatically logs agent responses to a shared transcript file
 * for multi-agent group chats where bots cannot see each other's
 * messages (e.g., Telegram, Signal).
 *
 * This hook fires on the message:sent internal event and appends
 * the response to the configured transcript file.
 */

import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveMultiAgentTranscriptConfig,
  platformNeedsTranscript,
  shouldLogResponse,
  formatTranscriptEntry,
} from "../../config/multi-agent-groups.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  registerInternalHook,
  isMessageSentEvent,
  type MessageSentHookEvent,
} from "../internal-hooks.js";

const log = createSubsystemLogger("multi-agent-transcript");

// Config reference — set during registration
let configRef: OpenClawConfig | null = null;

/**
 * Set the config reference for the hook.
 * Called during gateway startup.
 */
export function setMultiAgentTranscriptConfig(cfg: OpenClawConfig): void {
  configRef = cfg;
}

/**
 * Handle a message:sent event.
 * Appends the response to the transcript if configured.
 */
async function handleMessageSent(event: MessageSentHookEvent): Promise<void> {
  // Validate event
  if (!event.context.success) {
    return;
  }

  // Check if this is a group message
  if (!event.context.isGroup || !event.context.groupId) {
    return;
  }

  // Check platform needs transcript
  const channel = event.context.channelId;
  if (!platformNeedsTranscript(channel)) {
    log.debug(`Skipping transcript for ${channel} (native bot visibility)`);
    return;
  }

  // Check if content should be logged
  const content = event.context.content;
  if (!shouldLogResponse(content)) {
    log.debug("Skipping transcript for empty/NO_REPLY response");
    return;
  }

  // Get config
  if (!configRef) {
    log.warn("Multi-agent transcript hook called without config");
    return;
  }

  const groupId = event.context.groupId;
  const config = resolveMultiAgentTranscriptConfig(configRef, groupId);
  if (!config) {
    // No config for this group — feature not enabled
    return;
  }

  // Extract agent ID from session key
  // Session key format: agent:<agentId>:<channel>:<type>:<peerId>
  const agentId = extractAgentIdFromSessionKey(event.sessionKey);
  if (!agentId) {
    log.warn(`Could not extract agent ID from session key: ${event.sessionKey}`);
    return;
  }

  // Format and write entry
  const entry = formatTranscriptEntry(
    {
      timestamp: event.timestamp,
      agentId,
      content,
    },
    config.format,
  );

  try {
    // Ensure directory exists
    await mkdir(dirname(config.resolvedPath), { recursive: true });

    // Append entry
    await appendFile(config.resolvedPath, entry + "\n\n", { flag: "a" });

    log.debug(`Logged transcript entry for ${agentId} in group ${groupId}`);
  } catch (err) {
    log.error(
      `Failed to write transcript entry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Extract agent ID from session key.
 * Session key format: agent:<agentId>:...
 */
function extractAgentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(":");
  if (parts.length < 2 || parts[0] !== "agent") {
    return null;
  }
  return parts[1] || null;
}

/**
 * Register the multi-agent transcript hook.
 * Should be called during gateway startup.
 */
export function registerMultiAgentTranscriptHook(cfg: OpenClawConfig): void {
  setMultiAgentTranscriptConfig(cfg);

  registerInternalHook("message:sent", async (event) => {
    if (!isMessageSentEvent(event)) {
      return;
    }
    await handleMessageSent(event);
  });

  log.info("Multi-agent transcript hook registered");
}
