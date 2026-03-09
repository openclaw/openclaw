import process from "node:process";
import { shouldLogVerbose } from "../../globals.js";
import { getLogger } from "../../logging/logger.js";

export type DiscordVoicePerfTrace = {
  isVoiceMessage: boolean;
  startedAtMs: number;
  preflightFinishedAtMs?: number;
  preflightTranscriptionTriggered?: boolean;
  preflightTranscriptionDurationMs?: number;
  enqueueAtMs?: number;
};

function isVoicePerfEnvEnabled(): boolean {
  return process.env.OPENCLAW_VOICE_PERF === "1" || process.env.CLAWDBOT_VOICE_PERF === "1";
}

export function shouldLogDiscordVoicePerf(trace?: DiscordVoicePerfTrace | null): boolean {
  return Boolean(trace?.isVoiceMessage) && (isVoicePerfEnvEnabled() || shouldLogVerbose());
}

function normalizeFieldValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : null;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    try {
      const json = JSON.stringify(value);
      return json && json !== "{}" ? json : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return null;
  }
  return null;
}

export function logDiscordVoicePerf(params: {
  trace?: DiscordVoicePerfTrace | null;
  stage: string;
  messageId?: string;
  channelId?: string;
  fields?: Record<string, unknown>;
}): void {
  if (!shouldLogDiscordVoicePerf(params.trace)) {
    return;
  }
  const entries = [
    ["stage", params.stage],
    ["messageId", params.messageId],
    ["channelId", params.channelId],
    ...Object.entries(params.fields ?? {}),
  ]
    .map(([key, value]) => {
      const normalized = normalizeFieldValue(value);
      return normalized ? `${key}=${normalized}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (entries.length === 0) {
    return;
  }
  const message = `voice-perf: ${entries.join(" ")}`;
  try {
    getLogger().info({ message }, "voice-perf");
  } catch {
    // never let perf logs affect message handling
  }
}
