import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  assertVoiceSessionOwnership,
  readVoiceSessionRecordInTransaction,
  recordVoiceToolEffectInTransaction,
  registerVoiceConsultRunInTransaction,
  writeVoiceSessionRecordInTransaction,
  VOICE_SESSION_RECORD_VERSION,
  type ClientVoiceRunBinding,
  type ClientVoiceSessionRecord,
} from "./client-voice-session-store.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

export type VoiceSessionMutation = ClientVoiceRunBinding &
  (
    | {
        kind: "create";
        provider?: string;
        origin: "client" | "relay";
        transcriptCapable?: boolean;
        now: number;
      }
    | { kind: "consult"; runId: string; now: number }
    | { kind: "effect"; event: TrustedToolExecutionEvent; now: number }
    | {
        kind: "reserve";
        failureKey: string;
        origin: "client" | "relay";
        transcriptSessionKey?: string;
        now: number;
      }
    | { kind: "confirm"; failureKey: string; role: "user" | "assistant"; now: number }
    | {
        kind: "close";
        transcriptFailurePolicy: "require-success" | "retain-and-close";
        expectedOrigin?: "client";
        staleBefore?: number;
        now: number;
      }
    | { kind: "delivered"; deliveredAt: number; now: number }
  );

/** The caller owns the transaction; all predicates use its current canonical row. */
export function mutateVoiceSessionInDatabase(
  database: OpenClawAgentDatabase,
  input: VoiceSessionMutation,
): ClientVoiceSessionRecord | undefined {
  if (input.kind === "consult") {
    return registerVoiceConsultRunInTransaction(database, input);
  }
  if (input.kind === "effect") {
    return input.event.runId
      ? recordVoiceToolEffectInTransaction(
          database,
          input,
          input.event.runId,
          input.event,
          input.now,
        )
      : undefined;
  }
  let record = readVoiceSessionRecordInTransaction(database, input.voiceSessionId);
  if (!record) {
    if (input.kind === "delivered") {
      return undefined;
    }
    if (input.kind !== "create") {
      throw new Error("voice session not found");
    }
    record = {
      version: VOICE_SESSION_RECORD_VERSION,
      voiceSessionId: input.voiceSessionId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      ...(input.provider ? { provider: input.provider } : {}),
      origin: input.origin,
      ...(input.transcriptCapable === true ? { transcriptCapable: true } : {}),
      status: "open",
      createdAt: input.now,
      updatedAt: input.now,
      consultRunIds: [],
      effects: [],
      transcriptFailureKeys: [],
    };
  }
  assertVoiceSessionOwnership(record, input);
  switch (input.kind) {
    case "create":
      if (record.origin !== input.origin) {
        throw new Error("voice session origin does not match");
      }
      if (record.status !== "open") {
        throw new Error("voice session is already closed");
      }
      if (record.provider && input.provider && record.provider !== input.provider) {
        throw new Error("voice session provider does not match");
      }
      record.provider ??= input.provider;
      if (input.transcriptCapable === true) {
        record.transcriptCapable = true;
      }
      break;
    case "reserve":
      if (record.status !== "open") {
        throw new Error("voice session is closed");
      }
      if (record.origin !== input.origin) {
        throw new Error("voice session origin does not allow this transcript source");
      }
      if (!record.transcriptFailureKeys.includes(input.failureKey)) {
        if (record.transcriptFailureKeys.length >= VOICE_TRANSCRIPT_MAX_UNRESOLVED) {
          throw new Error("voice transcript persistence has too many unresolved entries");
        }
        record.transcriptFailureKeys.push(input.failureKey);
      }
      break;
    case "confirm":
      if (input.role === "user") {
        record.hasUserTranscript = true;
      }
      record.transcriptFailureKeys = record.transcriptFailureKeys.filter(
        (key) => key !== input.failureKey,
      );
      break;
    case "close":
      if (input.expectedOrigin && record.origin !== input.expectedOrigin) {
        throw new Error("relay-owned voice sessions close through talk.session.close");
      }
      if (
        input.staleBefore !== undefined &&
        (record.status !== "open" || record.updatedAt > input.staleBefore)
      ) {
        return undefined;
      }
      if (
        record.transcriptFailureKeys.length > 0 &&
        input.transcriptFailurePolicy === "require-success"
      ) {
        throw new Error("voice transcript persistence must be retried before close");
      }
      if (input.transcriptFailurePolicy === "retain-and-close" && record.origin !== "relay") {
        throw new Error("only relay voice sessions may close with unresolved transcripts");
      }
      if (record.status === "closed") {
        return record;
      }
      record.status = "closed";
      record.closedAt = input.now;
      break;
    case "delivered":
      if (record.digestDeliveredAt) {
        return record;
      }
      record.digestDeliveredAt = input.deliveredAt;
      break;
  }
  record.updatedAt = input.now;
  writeVoiceSessionRecordInTransaction(database, record);
  return record;
}
