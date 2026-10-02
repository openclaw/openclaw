import type { TranscriptSourceLocator } from "./provider-types.js";

/** Strip invitation credentials from meeting locators before persistence/provider handoff. */
export function sanitizeTranscriptSourceLocator(
  source: TranscriptSourceLocator,
): TranscriptSourceLocator {
  if (!source.meetingUrl) {
    return source;
  }
  const { meetingUrl: _meetingUrl, ...rest } = source;
  try {
    const url = new URL(source.meetingUrl);
    return { ...rest, meetingUrl: `${url.origin}${url.pathname}` };
  } catch {
    return rest;
  }
}

export function readTranscriptStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; trim?: boolean },
): string;
export function readTranscriptStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: false; trim?: boolean },
): string | undefined;
export function readTranscriptStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean } = {},
): string | undefined {
  const value = params[key];
  const normalized =
    typeof value === "string" ? (options.trim === false ? value : value.trim()) : undefined;
  if (!normalized && options.required) {
    throw new Error(`${key} required`);
  }
  return normalized || undefined;
}

// Provider routing comes from tool params so manual imports and live providers
// share one persisted source descriptor.
export function sourceFromParams(params: Record<string, unknown>): TranscriptSourceLocator {
  return {
    providerId: readTranscriptStringParam(params, "providerId") ?? "manual-transcript",
    accountId: readTranscriptStringParam(params, "accountId"),
    guildId: readTranscriptStringParam(params, "guildId"),
    channelId: readTranscriptStringParam(params, "channelId"),
    meetingUrl: readTranscriptStringParam(params, "meetingUrl"),
  };
}
