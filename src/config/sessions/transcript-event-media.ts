import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  copyInternalNativeInvocationStorage,
  getInternalNativeInvocationStorage,
} from "../../../packages/agent-core/src/internal-hooks.js";
import { canonicalizePersistedUserMessageMedia } from "../../media/media-facts.js";
import type { TranscriptEvent } from "./session-accessor.types.js";

export function canonicalizeTranscriptEventMedia(event: TranscriptEvent): TranscriptEvent {
  if (!isRecord(event)) {
    return event;
  }
  const message = event.message;
  if (event.type !== "message" || !isRecord(message)) {
    return event;
  }
  const canonical = canonicalizePersistedUserMessageMedia(message);
  return canonical.changed ? { ...event, message: canonical.message } : event;
}

/** Arbitrary message JSON never supplies native execution provenance. */
export function stripTranscriptNativeInvocation<T>(message: T): T {
  if (
    !isRecord(message) ||
    !isRecord(message["__openclaw"]) ||
    !Object.hasOwn(message["__openclaw"], "nativeInvocation")
  ) {
    return message;
  }
  const metadata = { ...message["__openclaw"] };
  delete metadata.nativeInvocation;
  return { ...message, __openclaw: metadata };
}

/** Preserve only the canonical writer's private, identity-bound preparation. */
export function prepareTranscriptNativeInvocation<T>(message: T): T {
  const stripped = stripTranscriptNativeInvocation(message);
  if (!isRecord(message)) {
    return stripped;
  }
  const fact = getInternalNativeInvocationStorage(message);
  if (
    !fact ||
    message.role !== "toolResult" ||
    message.isError ||
    message.toolCallId !== fact.toolCallId ||
    message.toolName !== fact.toolName ||
    !isRecord(message["__openclaw"]) ||
    message["__openclaw"].runId !== fact.runId
  ) {
    return stripped;
  }
  const prepared = { ...message, __openclaw: { ...message["__openclaw"], nativeInvocation: fact } };
  copyInternalNativeInvocationStorage(message, prepared);
  return prepared;
}

export function stripTranscriptEventNativeInvocation<T>(event: T): T {
  if (!isRecord(event) || event.type !== "message") {
    return event;
  }
  const message = stripTranscriptNativeInvocation(event.message);
  return message === event.message ? event : { ...event, message };
}

/** The caller must verify these original bytes against the canonical row at commit. */
export function preserveSameEntryNativeInvocation<T>(event: T, original: unknown): T {
  const stripped = stripTranscriptEventNativeInvocation(event);
  if (
    !isRecord(event) ||
    !isRecord(original) ||
    event.type !== "message" ||
    original.type !== "message" ||
    event.id !== original.id ||
    !isRecord(event.message) ||
    !isRecord(original.message) ||
    !isDeepStrictEqual(event.message["__openclaw"], original.message["__openclaw"]) ||
    !isDeepStrictEqual(stripped, stripTranscriptEventNativeInvocation(original))
  ) {
    return stripped;
  }
  return { ...event, message: original.message };
}
