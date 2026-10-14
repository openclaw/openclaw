import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import type { z } from "zod";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { OpenClawSchemaShape } from "../config/zod-schema.root-shape.js";

/**
 * Configuration normalization for transcript capture/import.
 *
 * Raw config can contain optional auto-start provider locators; resolution
 * returns bounded defaults and drops malformed entries before runtime startup.
 */
/** Raw auto-start transcript source entry from config. */
type TranscriptsAutoStartConfig = NonNullable<TranscriptsConfig["autoStart"]>[number];

/** Normalized auto-start source entry consumed by transcript runtime code. */
export type ResolvedTranscriptsAutoStartConfig = TranscriptsAutoStartConfig & {
  whenOccupied: boolean;
};

/** Raw transcripts config block. */
export type TranscriptsConfig = SchemaContract<
  NonNullable<z.input<typeof OpenClawSchemaShape.transcripts>>
>;

const DEFAULT_TRANSCRIPTS_MAX_UTTERANCES = 2_000;

function resolveAutoStart(raw: unknown): ResolvedTranscriptsAutoStartConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry): ResolvedTranscriptsAutoStartConfig | undefined => {
      const config = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const providerId = readString(config.providerId);
      if (!providerId) {
        return undefined;
      }
      return {
        providerId,
        whenOccupied: config.whenOccupied === true,
        sessionId: config.whenOccupied === true ? undefined : readString(config.sessionId),
        title: readString(config.title),
        accountId: readString(config.accountId),
        guildId: readString(config.guildId),
        channelId: readString(config.channelId),
        meetingUrl: readString(config.meetingUrl),
      };
    })
    .filter((entry): entry is ResolvedTranscriptsAutoStartConfig => entry !== undefined);
}

/** Normalize raw transcripts config into runtime settings. */
export function resolveTranscriptsConfig(raw: unknown) {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: config.enabled !== false,
    maxUtterances: DEFAULT_TRANSCRIPTS_MAX_UTTERANCES,
    autoStart: resolveAutoStart(config.autoStart),
  };
}
