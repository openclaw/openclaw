import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Names already generated in this process, so rapid-fire calls
// (e.g. multi-tool-feedback creating 10 channels in a loop) never
// collide even before the guild channel list is re-fetched.
const generatedNames = new Set<string>();

// Shared temp file for cross-process coordination. Vitest forks
// pool runs each test file in a separate process, each with its
// own generatedNames Set. Without a shared registry, two workers
// calling e2eChannelName in the same second both produce the same
// timestamp and create duplicate Discord channels. A directory-
// based lock (mkdir is atomic on all platforms) serialises the
// read-pick-claim cycle across workers.
const SHARED_NAMES_FILE = path.join(os.tmpdir(), "openclaw-e2e-channel-names.txt");
const SHARED_NAMES_LOCK = SHARED_NAMES_FILE + ".lock";

function acquireLock(): void {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(SHARED_NAMES_LOCK);
      return;
    } catch {
      // Lock held by another worker, spin briefly.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  // Deadline exceeded (stale lock from a crashed worker). Break
  // the lock and proceed — better than hanging the test suite.
  try {
    fs.rmdirSync(SHARED_NAMES_LOCK);
  } catch {
    // Already removed by another worker.
  }
  fs.mkdirSync(SHARED_NAMES_LOCK);
}

function releaseLock(): void {
  try {
    fs.rmdirSync(SHARED_NAMES_LOCK);
  } catch {
    // Already removed (shouldn't happen, but harmless).
  }
}

function readSharedNames(): Set<string> {
  try {
    const content = fs.readFileSync(SHARED_NAMES_FILE, "utf-8");
    return new Set(content.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Generate a standardized E2E channel name using the local
 * timestamp: `e2e-YYYY-MM-DD-t-HH-MM-SS`. When `existingNames`
 * is provided the seconds (and minutes/hours) are incremented
 * until the name is unique — the timestamp may not reflect the
 * real wall-clock time, but the format stays valid.
 *
 * Names are coordinated across parallel vitest workers via a
 * shared temp file protected by a directory lock.
 */
export function e2eChannelName(existingNames?: Iterable<string>): string {
  const taken = new Set<string>(existingNames);
  for (const n of generatedNames) {
    taken.add(n);
  }

  acquireLock();
  try {
    for (const n of readSharedNames()) {
      taken.add(n);
    }

    const cursor = new Date();
    cursor.setMilliseconds(0);

    let name = formatChannelTimestamp(cursor);

    while (taken.has(name)) {
      cursor.setSeconds(cursor.getSeconds() + 1);
      name = formatChannelTimestamp(cursor);
    }

    generatedNames.add(name);
    fs.appendFileSync(SHARED_NAMES_FILE, name + "\n");
    return name;
  } finally {
    releaseLock();
  }
}

function formatChannelTimestamp(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const min = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `e2e-${yyyy}-${mm}-${dd}-t-${hh}-${min}-${ss}`;
}

/**
 * Create an E2E text channel with a clash-free timestamp name.
 * Fetches existing guild channels, picks a unique name, and
 * creates the channel.
 */
export async function createE2eChannel(guild: Guild, topic: string) {
  const channels = await guild.channels.fetch();
  const existingNames = new Set<string>();
  for (const [, ch] of channels) {
    if (ch) {
      existingNames.add(ch.name);
    }
  }

  const name = e2eChannelName(existingNames);
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    topic,
  });
}

export function resolveTestBotToken(): string {
  const token = process.env.DISCORD_E2E_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Discord E2E bot token not found. Set the DISCORD_E2E_BOT_TOKEN " + "environment variable.",
    );
  }
  return token;
}

/**
 * Extract the bot user ID from a Discord bot token. Tokens are
 * structured as base64(user_id).timestamp.hmac — the first
 * dot-delimited segment decodes to the numeric user ID.
 */
export function botIdFromToken(token: string): string {
  const segment = token.split(".")[0];
  if (!segment) {
    throw new Error("Invalid Discord token format (no dot-delimited segments).");
  }
  const decoded = Buffer.from(segment, "base64").toString("utf-8");
  if (!/^\d+$/.test(decoded)) {
    throw new Error(
      "Invalid Discord token format (first segment does not decode to a numeric ID).",
    );
  }
  return decoded;
}

/**
 * Resolve E2E test configuration from environment variables and
 * the OpenClaw config file (~/.openclaw/openclaw.json).
 *
 * - `botId`: derived from the Discord bot token already configured
 *   in the OpenClaw config (channels.discord.token or
 *   channels.discord.accounts.default.token).
 * - `guildId`: from DISCORD_E2E_GUILD_ID env var or
 *   channels.discord.e2e.guildId in config.
 */
export function resolveE2eConfig(): { botId: string; guildId: string } {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // Config file missing or malformed — env vars are still checked.
  }

  const discord = (cfg.channels as Record<string, unknown>)?.discord as
    | Record<string, unknown>
    | undefined;

  // Resolve bot ID from the configured Discord token.
  const token =
    (discord?.token as string | undefined) ??
    ((discord?.accounts as Record<string, Record<string, unknown>>)?.default?.token as
      | string
      | undefined);

  if (!token) {
    throw new Error(
      "Cannot derive Discord bot ID. Set channels.discord.token " + "in ~/.openclaw/openclaw.json.",
    );
  }
  const botId = botIdFromToken(token);

  // Resolve guild ID.
  const e2e = discord?.e2e as Record<string, unknown> | undefined;
  const guildId = process.env.DISCORD_E2E_GUILD_ID?.trim() || (e2e?.guildId as string | undefined);

  if (!guildId) {
    throw new Error(
      "Discord E2E guild ID not found. Set DISCORD_E2E_GUILD_ID " +
        "or channels.discord.e2e.guildId in ~/.openclaw/openclaw.json.",
    );
  }

  return { botId, guildId };
}

export type MessageEvent = {
  type: "create" | "update" | "delete";
  messageId: string;
  content?: string;
  timestamp: number;
};

export async function waitForBotResponse(
  events: MessageEvent[],
  maxWaitMs: number,
  quietPeriodMs: number,
): Promise<void> {
  const startTime = Date.now();
  let lastEventTime = startTime;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 1000));

    const latestEvent = events[events.length - 1];
    if (latestEvent) {
      lastEventTime = latestEvent.timestamp;
    }

    const creates = events.filter((e) => e.type === "create");
    if (creates.length > 0 && Date.now() - lastEventTime >= quietPeriodMs) {
      break;
    }
  }
}
