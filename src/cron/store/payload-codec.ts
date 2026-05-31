import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronPayload } from "../types.js";
import {
  booleanToInteger,
  integerToBoolean,
  normalizeNumber,
  optionalBooleanFromRecord,
  optionalNumberFromRecord,
  optionalStringArrayFromRecord,
  optionalStringFromRecord,
  parseJsonArray,
  parseJsonValue,
  serializeJson,
} from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

function parseExternalContentSource(
  raw: string | null,
  fallback: unknown,
): "gmail" | "webhook" | undefined {
  const parsed = raw ? parseJsonValue<unknown>(raw, undefined) : fallback;
  return parsed === "gmail" || parsed === "webhook" ? parsed : undefined;
}

export function bindPayloadColumns(
  payload: CronPayload,
): Pick<
  CronJobInsert,
  | "payload_allow_unsafe_external_content"
  | "payload_external_content_source_json"
  | "payload_fallbacks_json"
  | "payload_kind"
  | "payload_light_context"
  | "payload_message"
  | "payload_model"
  | "payload_thinking"
  | "payload_timeout_seconds"
  | "payload_tools_allow_json"
> {
  if (payload.kind === "systemEvent") {
    return {
      payload_kind: "systemEvent",
      payload_message: payload.text,
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: null,
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: null,
      payload_light_context: null,
      payload_tools_allow_json: null,
    };
  }
  return {
    payload_kind: "agentTurn",
    payload_message: payload.message,
    payload_model: payload.model ?? null,
    payload_fallbacks_json: serializeJson(payload.fallbacks),
    payload_thinking: payload.thinking ?? null,
    payload_timeout_seconds: payload.timeoutSeconds ?? null,
    payload_allow_unsafe_external_content: booleanToInteger(payload.allowUnsafeExternalContent),
    payload_external_content_source_json: serializeJson(payload.externalContentSource),
    payload_light_context: booleanToInteger(payload.lightContext),
    payload_tools_allow_json: serializeJson(payload.toolsAllow),
  };
}

export function payloadFromRow(row: CronJobRow, fallback: unknown): CronPayload | null {
  const fallbackRecord = isRecord(fallback) ? fallback : {};
  if (row.payload_kind === "systemEvent") {
    const text = row.payload_message ?? optionalStringFromRecord(fallbackRecord, "text");
    return text == null ? null : { kind: "systemEvent", text };
  }
  if (row.payload_kind === "agentTurn") {
    const message = row.payload_message ?? optionalStringFromRecord(fallbackRecord, "message");
    if (message == null) {
      return null;
    }
    const model = row.payload_model ?? optionalStringFromRecord(fallbackRecord, "model");
    const fallbacks = row.payload_fallbacks_json
      ? parseJsonArray(row.payload_fallbacks_json)
      : optionalStringArrayFromRecord(fallbackRecord, "fallbacks");
    const thinking = row.payload_thinking ?? optionalStringFromRecord(fallbackRecord, "thinking");
    const timeoutSeconds =
      row.payload_timeout_seconds != null
        ? normalizeNumber(row.payload_timeout_seconds)
        : optionalNumberFromRecord(fallbackRecord, "timeoutSeconds");
    const allowUnsafeExternalContent =
      row.payload_allow_unsafe_external_content != null
        ? integerToBoolean(row.payload_allow_unsafe_external_content)
        : optionalBooleanFromRecord(fallbackRecord, "allowUnsafeExternalContent");
    const externalContentSource = parseExternalContentSource(
      row.payload_external_content_source_json,
      fallbackRecord.externalContentSource,
    );
    const lightContext =
      row.payload_light_context != null
        ? integerToBoolean(row.payload_light_context)
        : optionalBooleanFromRecord(fallbackRecord, "lightContext");
    const toolsAllow = row.payload_tools_allow_json
      ? parseJsonArray(row.payload_tools_allow_json)
      : optionalStringArrayFromRecord(fallbackRecord, "toolsAllow");
    return {
      kind: "agentTurn",
      message,
      ...(model ? { model } : {}),
      ...(fallbacks ? { fallbacks } : {}),
      ...(thinking ? { thinking } : {}),
      ...(timeoutSeconds != null ? { timeoutSeconds } : {}),
      ...(allowUnsafeExternalContent != null ? { allowUnsafeExternalContent } : {}),
      ...(externalContentSource ? { externalContentSource } : {}),
      ...(lightContext != null ? { lightContext } : {}),
      ...(toolsAllow ? { toolsAllow } : {}),
    };
  }
  return null;
}
