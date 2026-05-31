import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";

export type TranscriptsAutoStartConfig = {
  providerId: string;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

export type ResolvedTranscriptsAutoStartConfig = {
  providerId: string;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

export type TranscriptsConfig = {
  enabled?: boolean;
  maxUtterances?: number;
  autoStart?: TranscriptsAutoStartConfig[];
};

export type ResolvedTranscriptsConfig = {
  enabled: boolean;
  maxUtterances: number;
  autoStart: ResolvedTranscriptsAutoStartConfig[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveAutoStart(raw: unknown): ResolvedTranscriptsAutoStartConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry): ResolvedTranscriptsAutoStartConfig | undefined => {
      const config = isRecord(entry) ? entry : {};
      const providerId = readString(config.providerId);
      if (!providerId) {
        return undefined;
      }
      return {
        providerId,
        sessionId: readString(config.sessionId),
        title: readString(config.title),
        accountId: readString(config.accountId),
        guildId: readString(config.guildId),
        channelId: readString(config.channelId),
        meetingUrl: readString(config.meetingUrl),
      };
    })
    .filter((entry): entry is ResolvedTranscriptsAutoStartConfig => entry !== undefined);
}

export function resolveTranscriptsConfig(raw: unknown): ResolvedTranscriptsConfig {
  const config = isRecord(raw) ? raw : {};
  const maxUtterances =
    typeof config.maxUtterances === "number" && Number.isFinite(config.maxUtterances)
      ? Math.max(1, Math.min(10_000, Math.floor(config.maxUtterances)))
      : 2_000;
  return {
    enabled: config.enabled === true,
    maxUtterances,
    autoStart: resolveAutoStart(config.autoStart),
  };
}
