/**
 * Multi-Agent Group Configuration Resolution
 *
 * Provides helpers for resolving multi-agent group transcript
 * configuration from the OpenClaw config.
 */

import { homedir } from "os";
import { resolve } from "path";
import type { OpenClawConfig } from "./config.js";
import {
  type MultiAgentGroupConfig,
  type TranscriptEntry,
  MULTI_AGENT_DEFAULTS,
} from "./types.multi-agent.js";

/**
 * Platforms where bots can see each other's messages natively.
 * Transcript feature is a no-op on these platforms.
 */
/**
 * Platforms where bots can see each other's messages natively.
 * - slack: OAuth scopes grant full channel history
 * - discord: Bots see all messages in channels they have access to
 * - mattermost: Similar to Slack
 * - irc: All clients see all messages (no bot isolation)
 */
const PLATFORMS_WITH_NATIVE_BOT_VISIBILITY = new Set([
  "slack",
  "discord",
  "mattermost",
  "irc",
]);

/**
 * Check if a platform needs the transcript feature.
 * Returns false for platforms with native bot-to-bot visibility.
 */
export function platformNeedsTranscript(channel: string): boolean {
  return !PLATFORMS_WITH_NATIVE_BOT_VISIBILITY.has(channel.toLowerCase());
}

/**
 * Expand ~ to home directory in paths.
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

/**
 * Resolve the multi-agent transcript config for a specific group.
 * Returns null if no config exists or the group is not configured.
 */
export function resolveMultiAgentTranscriptConfig(
  cfg: OpenClawConfig,
  groupId: string,
): (MultiAgentGroupConfig & { resolvedPath: string }) | null {
  const groups = cfg.multiAgentGroups;
  if (!groups || typeof groups !== "object") {
    return null;
  }

  const config = groups[groupId];
  if (!config || typeof config !== "object") {
    return null;
  }

  if (!config.transcriptPath) {
    return null;
  }

  // Check if explicitly disabled
  if (config.enabled === false) {
    return null;
  }

  return {
    ...config,
    contextLimit: config.contextLimit ?? MULTI_AGENT_DEFAULTS.contextLimit,
    pruneAfterHours: config.pruneAfterHours ?? MULTI_AGENT_DEFAULTS.pruneAfterHours,
    format: config.format ?? MULTI_AGENT_DEFAULTS.format,
    enabled: config.enabled ?? MULTI_AGENT_DEFAULTS.enabled,
    resolvedPath: expandPath(config.transcriptPath),
  };
}

/**
 * Get all configured multi-agent group IDs.
 */
export function listMultiAgentGroupIds(cfg: OpenClawConfig): string[] {
  const groups = cfg.multiAgentGroups;
  if (!groups || typeof groups !== "object") {
    return [];
  }
  return Object.keys(groups).filter((id) => {
    const config = groups[id];
    return config && config.transcriptPath && config.enabled !== false;
  });
}

/**
 * Check if a response content should be logged to transcript.
 * Filters out empty responses and NO_REPLY patterns.
 */
export function shouldLogResponse(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  // Filter out silent reply patterns
  if (trimmed === "NO_REPLY") {
    return false;
  }
  // Filter out very short non-meaningful responses
  if (trimmed.length < 2) {
    return false;
  }
  return true;
}

/**
 * Format a transcript entry for writing.
 * 
 * Note: Markdown format truncates content to 200 chars for readability in the
 * transcript file. Context injection reads full content from JSON format or
 * aggregates markdown entries. This is intentional — transcript file is for
 * human review, context injection needs full detail.
 */
export function formatTranscriptEntry(
  entry: TranscriptEntry,
  format: "markdown" | "json" = "markdown",
): string {
  if (format === "json") {
    return JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      agentId: entry.agentId,
      content: entry.content,
    });
  }

  // Markdown format
  const dateStr = entry.timestamp.toISOString().replace("T", " ").slice(0, 19);
  // Summarize long content for transcript (first 200 chars)
  const summary =
    entry.content.length > 200
      ? entry.content.slice(0, 200).trim() + "..."
      : entry.content;

  return `### ${dateStr} - ${entry.agentId}\n${summary}`;
}

/**
 * Parse a transcript entry from a string.
 */
export function parseTranscriptEntry(
  line: string,
  format: "markdown" | "json" = "markdown",
): TranscriptEntry | null {
  if (format === "json") {
    try {
      const parsed = JSON.parse(line);
      return {
        timestamp: new Date(parsed.timestamp),
        agentId: parsed.agentId,
        content: parsed.content,
      };
    } catch {
      return null;
    }
  }

  // Markdown format: ### YYYY-MM-DD HH:MM:SS - agentId
  // Agent IDs can contain letters, numbers, underscores, and hyphens
  const headerMatch = line.match(/^### (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - ([\w-]+)$/);
  if (!headerMatch) {
    return null;
  }

  return {
    timestamp: new Date(headerMatch[1].replace(" ", "T") + "Z"),
    agentId: headerMatch[2],
    content: "", // Content follows on next lines
  };
}
