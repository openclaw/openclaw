// Injects OpenAI's `safety_identifier` into native OpenAI Platform request payloads.
import { resolveOpenAIResponsesPayloadPolicy } from "@openclaw/ai/transports";
import type { StreamFn } from "../../../agents/runtime/index.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { streamSimple } from "../../stream.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

const log = createSubsystemLogger("llm/providers/stream-wrappers");

// OpenAI documents `safety_identifier` as a stable per-user string with a
// maximum length of 64 characters (see the SDK field docs); longer values are
// rejected upstream and are almost certainly raw PII sent by mistake.
const OPENAI_SAFETY_IDENTIFIER_MAX_LENGTH = 64;

function shouldApplyOpenAISafetyIdentifier(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  return resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" })
    .allowsSafetyIdentifier;
}

/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export function resolveOpenAISafetyIdentifier(
  extraParams: Record<string, unknown> | undefined,
): string | undefined {
  // Single canonical spelling on purpose: extra params are merged across the
  // global/model/agent scopes by literal key before reaching this resolver, so
  // accepting an alias here would let a lower-precedence scope's spelling win
  // over a higher-precedence override written with the other spelling.
  const raw = extraParams?.safetyIdentifier;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const normalized = typeof raw === "string" ? raw.trim() : "";
  if (normalized.length === 0 || normalized.length > OPENAI_SAFETY_IDENTIFIER_MAX_LENGTH) {
    const rawSummary = typeof raw === "string" ? `string(${raw.length})` : typeof raw;
    log.warn(`ignoring invalid OpenAI safety identifier param: ${rawSummary}`);
    return undefined;
  }
  return normalized;
}

/**
 * Injects OpenAI's `safety_identifier` (see
 * https://developers.openai.com/api/docs/guides/safety-best-practices#safety_identifiers)
 * into native OpenAI Platform Responses and Chat Completions payloads. Caller-provided
 * values win; non-native routes are left untouched.
 *
 * @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins.
 */
export function createOpenAISafetyIdentifierWrapper(
  baseStreamFn: StreamFn | undefined,
  safetyIdentifier: string,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldApplyOpenAISafetyIdentifier(model)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.safety_identifier === undefined) {
        payloadObj.safety_identifier = safetyIdentifier;
      }
    });
  };
}
