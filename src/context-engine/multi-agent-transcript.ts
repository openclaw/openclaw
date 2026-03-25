/**
 * Multi-Agent Transcript Context Injection
 *
 * Reads recent transcript entries and injects them into agent context
 * so agents can see what their peers have said in the group.
 */

import { readFile, stat, writeFile } from "fs/promises";
import {
  resolveMultiAgentTranscriptConfig,
  platformNeedsTranscript,
  type TranscriptEntry,
} from "../config/multi-agent-groups.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("multi-agent-transcript-context");

/**
 * Parameters for injecting multi-agent transcript into context.
 */
export type InjectTranscriptParams = {
  cfg: OpenClawConfig;
  channel: string;
  groupId: string;
  agentId: string;
};

/**
 * Read and parse transcript entries from a file.
 */
async function readTranscriptEntries(
  filePath: string,
  format: "markdown" | "json",
  limit: number,
): Promise<TranscriptEntry[]> {
  try {
    // Check if file exists
    await stat(filePath);
  } catch {
    // File doesn't exist yet
    return [];
  }

  try {
    const content = await readFile(filePath, "utf-8");
    const entries: TranscriptEntry[] = [];

    if (format === "json") {
      // JSON: one entry per line
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          entries.push({
            timestamp: new Date(parsed.timestamp),
            agentId: parsed.agentId,
            content: parsed.content,
          });
        } catch {
          // Skip malformed lines
        }
      }
    } else {
      // Markdown: parse header + content blocks
      const blocks = content.split(/(?=^### \d{4}-\d{2}-\d{2})/m).filter((b) => b.trim());
      for (const block of blocks) {
        const lines = block.split("\n");
        const headerLine = lines[0];
        const headerMatch = headerLine?.match(
          /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) - ([\w-]+)/,
        );
        if (headerMatch) {
          const [, date, time, agentId] = headerMatch;
          const contentLines = lines.slice(1).join("\n").trim();
          entries.push({
            timestamp: new Date(`${date}T${time}Z`),
            agentId,
            content: contentLines,
          });
        }
      }
    }

    // Return most recent entries up to limit
    return entries.slice(-limit);
  } catch (err) {
    log.error(`Failed to read transcript: ${err}`);
    return [];
  }
}

/**
 * Format transcript entries for context injection.
 */
function formatEntriesForContext(
  entries: TranscriptEntry[],
  config: { contextLimit: number; pruneAfterHours: number },
): string {
  if (entries.length === 0) {
    return "";
  }

  const header = `## Peer Agent Activity (last ${config.contextLimit} entries, up to ${config.pruneAfterHours}h)
The following shows recent messages from other agents in this group chat.
You cannot see their messages directly — this transcript provides shared context.
`;

  const formattedEntries = entries
    .map((e) => {
      const dateStr = e.timestamp.toISOString().replace("T", " ").slice(0, 19);
      return `### ${dateStr} - ${e.agentId}\n${e.content}`;
    })
    .join("\n\n");

  return header + "\n" + formattedEntries;
}

/**
 * Inject multi-agent transcript into context.
 *
 * Returns formatted transcript string to include in system prompt,
 * or null if no transcript should be injected.
 */
export async function injectMultiAgentTranscript(
  params: InjectTranscriptParams,
): Promise<string | null> {
  const { cfg, channel, groupId, agentId } = params;

  // Check platform needs transcript
  if (!platformNeedsTranscript(channel)) {
    return null;
  }

  // Get config
  const config = resolveMultiAgentTranscriptConfig(cfg, groupId);
  if (!config) {
    return null;
  }

  // Read entries
  const allEntries = await readTranscriptEntries(
    config.resolvedPath,
    config.format ?? "markdown",
    config.contextLimit,
  );

  if (allEntries.length === 0) {
    return null;
  }

  // Filter out current agent's entries (they see their own history)
  const peerEntries = allEntries.filter(
    (e) => e.agentId.toLowerCase() !== agentId.toLowerCase(),
  );

  if (peerEntries.length === 0) {
    return null;
  }

  // Filter out old entries based on pruneAfterHours
  const cutoffTime = Date.now() - config.pruneAfterHours * 60 * 60 * 1000;
  const recentEntries = peerEntries.filter(
    (e) => e.timestamp.getTime() > cutoffTime,
  );

  if (recentEntries.length === 0) {
    return null;
  }

  return formatEntriesForContext(recentEntries, config);
}

/**
 * Prune old entries from a transcript file.
 * Called on gateway startup or manually via CLI.
 */
export async function pruneTranscript(
  filePath: string,
  format: "markdown" | "json",
  pruneAfterHours: number,
): Promise<{ removed: number; remaining: number }> {
  const allEntries = await readTranscriptEntries(filePath, format, Infinity);
  const cutoffTime = Date.now() - pruneAfterHours * 60 * 60 * 1000;

  const recentEntries = allEntries.filter(
    (e) => e.timestamp.getTime() > cutoffTime,
  );

  const removed = allEntries.length - recentEntries.length;

  if (removed === 0) {
    return { removed: 0, remaining: allEntries.length };
  }

  // Rewrite file with only recent entries
  if (format === "json") {
    const content = recentEntries
      .map((e) =>
        JSON.stringify({
          timestamp: e.timestamp.toISOString(),
          agentId: e.agentId,
          content: e.content,
        }),
      )
      .join("\n");
    await writeFile(filePath, content + "\n");
  } else {
    const content = recentEntries
      .map((e) => {
        const dateStr = e.timestamp.toISOString().replace("T", " ").slice(0, 19);
        return `### ${dateStr} - ${e.agentId}\n${e.content}`;
      })
      .join("\n\n");
    await writeFile(filePath, content + "\n");
  }

  log.info(`Pruned ${removed} old entries from transcript, ${recentEntries.length} remaining`);
  return { removed, remaining: recentEntries.length };
}
