import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("channel-bootstrap");

const CHANNEL_CONTEXT_HEADING = "\n\n---\n\n## 📡 Channel-Specific Context\n\n";

/**
 * Extracts the channel or group ID from an OpenClaw session key.
 *
 * Supported patterns:
 *   Discord channel:  agent:main:discord:channel:123456
 *   Discord thread:   agent:main:discord:channel:123456:thread:789  → 123456
 *   Telegram group:   agent:main:telegram:group:-100123456789
 *   Slack channel:    agent:main:slack:channel:c0123abcdef (lowercased by session-key.ts)
 *   WhatsApp group:   agent:main:whatsapp:group:120363403215116621@g.us
 *   Signal group:    agent:main:signal:group:abc123def456==
 *   iMessage group:  agent:main:imessage:group:chat123456
 *   Generic:         agent:main:<channel>:channel|group:<id>  (fallback)
 *   Signal group:    agent:main:signal:group:abc123def456==
 *   iMessage group:  agent:main:imessage:group:chat123456
 *   Generic:         agent:main:<channel>:channel|group:<id>  (fallback)
 *
 * Returns the extracted ID as-is (preserving case from the session key).
 * Callers that need case-insensitive file lookup should handle that separately.
 */
export function extractChannelId(sessionKey: string): string | null {
  const discordChannel = sessionKey.match(/:discord:channel:(\d+)/);
  if (discordChannel) {
    return discordChannel[1];
  }

  const telegramGroup = sessionKey.match(/:telegram:group:(-?\d+)/);
  if (telegramGroup) {
    return telegramGroup[1];
  }

  // Case-insensitive: session-key.ts lowercases peerId, so Slack IDs are lowercase at runtime
  const slackChannel = sessionKey.match(/:slack:channel:([A-Z0-9]+)/i);
  if (slackChannel) {
    return slackChannel[1];
  }

  const waGroup = sessionKey.match(/:whatsapp:group:([^:]+)/);
  if (waGroup) {
    return waGroup[1];
  }

  // Signal group: agent:main:signal:group:abc123def456==
  const signalGroup = sessionKey.match(/:signal:group:([^:]+)/);
  if (signalGroup) {
    return signalGroup[1];
  }

  // iMessage group: agent:main:imessage:group:chat123456
  const imessageGroup = sessionKey.match(/:imessage:group:([^:]+)/);
  if (imessageGroup) {
    return imessageGroup[1];
  }

  // Generic fallback for other channels: agent:main:<channel>:channel|group:<id>
  const genericChannel = sessionKey.match(/:([\w-]+):(?:channel|group):([^:]+)/);
  if (genericChannel) {
    return genericChannel[2];
  }

  return null;
}

/**
 * Try to read a channel context file, falling back to uppercase variant for
 * case-sensitive filesystems where Slack IDs are lowercased in session keys
 * but users may name files with canonical uppercase (e.g. C0123ABCDEF.md).
 */
function tryReadChannelFile(channelsDir: string, channelId: string): string | null {
  const candidates = [channelId];

  // For Slack-style IDs (alphanumeric, starts with letter), also try uppercase
  if (/^[a-z]/i.test(channelId) && channelId !== channelId.toUpperCase()) {
    candidates.push(channelId.toUpperCase());
  }

  for (const candidate of candidates) {
    const filePath = path.join(channelsDir, `${candidate}.md`);
    try {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (content) {
        return content;
      }
    } catch (err: unknown) {
      // Only silently skip file-not-found; surface other errors
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      log.warn(`failed to read ${filePath}: ${String(err)}`);
      return null;
    }
  }

  return null;
}

const channelBootstrapHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const { workspaceDir, bootstrapFiles, sessionKey } = event.context;
  if (!workspaceDir || !bootstrapFiles) {
    return;
  }

  const channelId = extractChannelId(sessionKey ?? "");
  if (!channelId) {
    return;
  }

  const channelsDir = path.join(workspaceDir, "channels");
  const channelContent = tryReadChannelFile(channelsDir, channelId);
  if (!channelContent) {
    return;
  }

  // Work on a shallow copy of the array to avoid mutating the cached snapshot
  // from bootstrap-cache.ts (which reuses the same array across agent:bootstrap
  // calls within a session).
  const updatedFiles = [...bootstrapFiles];

  const agentsIndex = updatedFiles.findIndex((f) => f.name === "AGENTS.md" && !f.missing);
  if (agentsIndex !== -1) {
    const original = updatedFiles[agentsIndex];
    updatedFiles[agentsIndex] = {
      ...original,
      content: (original.content ?? "") + CHANNEL_CONTEXT_HEADING + channelContent,
    };
    log.debug(`appended channel context for ${channelId} to AGENTS.md`);
  } else {
    // Remove any missing placeholder to avoid contradictory [MISSING] + injected content
    const missingIndex = updatedFiles.findIndex((f) => f.name === "AGENTS.md" && f.missing);
    if (missingIndex !== -1) {
      updatedFiles.splice(missingIndex, 1);
    }

    updatedFiles.push({
      name: "AGENTS.md",
      path: path.join(workspaceDir, "AGENTS.md"),
      content: `## 📡 Channel-Specific Context\n\n${channelContent}`,
      missing: false,
    });
    log.debug(`injected channel context for ${channelId} as new AGENTS.md entry`);
  }

  // Replace the entire array contents so the context reference is updated
  // without breaking the caller's reference to event.context.bootstrapFiles
  bootstrapFiles.length = 0;
  bootstrapFiles.push(...updatedFiles);
};

export default channelBootstrapHook;
