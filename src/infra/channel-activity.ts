import fs from "node:fs";
import path from "node:path";
import type { ChannelId } from "../channels/plugins/types.js";
import { resolveStateDir } from "../config/paths.js";
import { writeJsonAtomic } from "./json-files.js";
export type ChannelDirection = "inbound" | "outbound";

type ActivityEntry = {
  inboundAt: number | null;
  outboundAt: number | null;
};

const activity = new Map<string, ActivityEntry>();
const CHANNEL_ACTIVITY_FILENAME = "channel-activity.json";
let hydratedFromDisk = false;
let flushTimer: NodeJS.Timeout | null = null;

function resolveChannelActivityPath() {
  return path.join(resolveStateDir(), CHANNEL_ACTIVITY_FILENAME);
}

function keyFor(channel: ChannelId, accountId: string) {
  return `${channel}:${accountId || "default"}`;
}

function hydrateFromDiskIfNeeded() {
  if (hydratedFromDisk) {
    return;
  }
  hydratedFromDisk = true;
  try {
    const raw = fs.readFileSync(resolveChannelActivityPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, ActivityEntry>;
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const inboundAt =
        typeof value.inboundAt === "number" && Number.isFinite(value.inboundAt)
          ? value.inboundAt
          : null;
      const outboundAt =
        typeof value.outboundAt === "number" && Number.isFinite(value.outboundAt)
          ? value.outboundAt
          : null;
      activity.set(key, { inboundAt, outboundAt });
    }
  } catch {
    // Best-effort hydration only.
  }
}

function scheduleFlush() {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const payload = Object.fromEntries(activity.entries());
    void writeJsonAtomic(resolveChannelActivityPath(), payload, {
      trailingNewline: true,
    }).catch(() => undefined);
  }, 100);
  flushTimer.unref?.();
}

function ensureEntry(channel: ChannelId, accountId: string): ActivityEntry {
  hydrateFromDiskIfNeeded();
  const key = keyFor(channel, accountId);
  const existing = activity.get(key);
  if (existing) {
    return existing;
  }
  const created: ActivityEntry = { inboundAt: null, outboundAt: null };
  activity.set(key, created);
  return created;
}

export function recordChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
  direction: ChannelDirection;
  at?: number;
}) {
  hydrateFromDiskIfNeeded();
  const at = typeof params.at === "number" ? params.at : Date.now();
  const accountId = params.accountId?.trim() || "default";
  const entry = ensureEntry(params.channel, accountId);
  if (params.direction === "inbound") {
    entry.inboundAt = at;
  }
  if (params.direction === "outbound") {
    entry.outboundAt = at;
  }
  scheduleFlush();
}

export function getChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
}): ActivityEntry {
  hydrateFromDiskIfNeeded();
  const accountId = params.accountId?.trim() || "default";
  return (
    activity.get(keyFor(params.channel, accountId)) ?? {
      inboundAt: null,
      outboundAt: null,
    }
  );
}

export function resetChannelActivityForTest() {
  activity.clear();
  hydratedFromDisk = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
