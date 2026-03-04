import type { DeliverableMessageChannel } from "../utils/message-channel.js";
import { normalizeDeliverableOutboundChannel } from "./outbound/channel-resolution.js";

export type HeartbeatNotifyTarget = {
  channel: DeliverableMessageChannel;
  to: string;
};

const NOTIFY_LINE_REGEX = /^\s*notify:\s*(.+)$/im;

/**
 * Parse a single "channel:target" spec (e.g. "discord:#autopilot", "telegram:@user").
 * Returns undefined for invalid or unsupported formats.
 */
export function parseHeartbeatNotifyTarget(raw: string): HeartbeatNotifyTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx <= 0 || colonIdx === trimmed.length - 1) {
    return undefined;
  }
  const channelRaw = trimmed.slice(0, colonIdx).trim();
  const to = trimmed.slice(colonIdx + 1).trim();
  if (!to) {
    return undefined;
  }
  const channel = normalizeDeliverableOutboundChannel(channelRaw);
  if (!channel) {
    return undefined;
  }
  return { channel, to };
}

/**
 * Parse a comma-separated list of "channel:target" specs.
 * Invalid entries are silently skipped.
 */
export function parseHeartbeatNotifyTargets(raw: string): HeartbeatNotifyTarget[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const result: HeartbeatNotifyTarget[] = [];
  for (const part of parts) {
    const target = parseHeartbeatNotifyTarget(part);
    if (!target) {
      continue;
    }
    const key = `${target.channel}:${target.to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(target);
  }
  return result;
}

/**
 * Extract all notify targets from HEARTBEAT.md content.
 * Collects every line matching "notify: ...", parses and deduplicates.
 */
export function extractHeartbeatNotifyTargets(content: string): HeartbeatNotifyTarget[] {
  if (!content || typeof content !== "string") {
    return [];
  }
  const seen = new Set<string>();
  const result: HeartbeatNotifyTarget[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const match = line.match(NOTIFY_LINE_REGEX);
    if (!match?.[1]) {
      continue;
    }
    const targets = parseHeartbeatNotifyTargets(match[1]);
    for (const target of targets) {
      const key = `${target.channel}:${target.to}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(target);
    }
  }
  return result;
}
