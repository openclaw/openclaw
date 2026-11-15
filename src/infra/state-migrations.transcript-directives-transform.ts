import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { replaceOutsideCodeRegions } from "../utils/directive-tags.js";

// Historical reaction directives were transient actions, not durable delivery facts.
const LEGACY_REACTION_DIRECTIVE_RE =
  /\[\[\s*(?:react|react_to_current)\s*:\s*([^\]\n]+?)\s*\]\]/giu;

function parseDirectiveMigrationTranscriptEvent(raw: string, owner: string): TranscriptEvent {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${owner} contains invalid transcript JSON`, { cause: error });
  }
}

function transformHistoricalTranscriptEvent(event: TranscriptEvent): {
  changed: boolean;
  event: TranscriptEvent;
} {
  if (
    !isRecord(event) ||
    event.type !== "message" ||
    !isRecord(event.message) ||
    event.message.role !== "assistant" ||
    !Array.isArray(event.message.content)
  ) {
    return { changed: false, event };
  }
  const before = JSON.stringify(event.message);
  for (const part of event.message.content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      continue;
    }
    let changed = false;
    const stripped = replaceOutsideCodeRegions(part.text, LEGACY_REACTION_DIRECTIVE_RE, () => {
      changed = true;
      return "";
    });
    if (changed) {
      part.text = stripped.trimStart();
    }
  }
  applyAssistantDeliveryDirectives(event.message);
  return { changed: JSON.stringify(event.message) !== before, event };
}

/**
 * Transcript storage before 2026.10.12 redacted every registered secret value, and short
 * values were stored as this literal. Runtime headers such as `Openai-Organization`
 * registered some provider ids as secrets, so their assistant rows lost the provider.
 */
export const MASKED_TRANSCRIPT_PROVIDER = "***";
export const MASKED_PROVIDER_JSON = `"provider":"${MASKED_TRANSCRIPT_PROVIDER}"`;

export type HistoricalTranscriptRepairScope = "all" | "masked-provider";

export type HistoricalTranscriptLineResult = {
  changed: boolean;
  content: string;
  // Directive edits change searchable text and are not reversible from a recorded row list.
  directivesChanged: boolean;
  maskedProvider?: "restored" | "unresolved";
};

/** One historical-transcript repair for stored JSON: directive normalization and masked providers. */
export function repairHistoricalTranscriptEventJson(params: {
  raw: string;
  owner: string;
  scope: HistoricalTranscriptRepairScope;
  // Recorded provider for this event's session and model, or undefined when not exactly one.
  resolveMaskedProvider: (model: string) => string | undefined;
}): HistoricalTranscriptLineResult {
  const providerCandidate = params.raw.includes(MASKED_PROVIDER_JSON);
  if (params.scope === "masked-provider" && !providerCandidate) {
    return { changed: false, content: params.raw, directivesChanged: false };
  }
  const event = parseDirectiveMigrationTranscriptEvent(params.raw, params.owner);
  const directivesChanged =
    params.scope === "all" && transformHistoricalTranscriptEvent(event).changed;
  let changed = directivesChanged;
  let maskedProvider: HistoricalTranscriptLineResult["maskedProvider"];
  if (
    providerCandidate &&
    isRecord(event) &&
    event.type === "message" &&
    isRecord(event.message) &&
    event.message.role === "assistant" &&
    event.message.provider === MASKED_TRANSCRIPT_PROVIDER
  ) {
    const provider =
      typeof event.message.model === "string"
        ? params.resolveMaskedProvider(event.message.model)
        : undefined;
    if (provider) {
      event.message.provider = provider;
      changed = true;
      maskedProvider = "restored";
    } else {
      maskedProvider = "unresolved";
    }
  }
  return {
    changed,
    content: changed ? JSON.stringify(event) : params.raw,
    directivesChanged,
    maskedProvider,
  };
}
