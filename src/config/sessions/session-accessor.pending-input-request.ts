import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionPendingInputRow } from "./session-accessor.sqlite-pending-inputs.js";
import { redactTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

function resolvePendingInputRequestHash(
  message: Record<string, unknown>,
  requestFingerprint?: string,
): string {
  return requestFingerprint
    ? `request:${requestFingerprint}`
    : createHash("sha256").update(stableStringify(message)).digest("hex");
}

function preparePendingInputMessage(
  message: PersistedUserTurnMessage,
  requestFingerprint?: string,
) {
  const { timestamp: _timestamp, ...stableMessage } = message;
  if (Buffer.byteLength(JSON.stringify(stableMessage), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Pending input exceeds the Gateway payload limit");
  }
  return {
    stableMessage,
    requestHash: resolvePendingInputRequestHash(stableMessage, requestFingerprint),
  };
}

export type PendingInputRequest = {
  message: PersistedUserTurnMessage;
  runId: string;
  /** Authenticated ingress binds raw input before randomized media preparation. */
  requestFingerprint?: string;
  /** Trusted frozen-cohort sources, checked against a receipt or whole committed input. */
  replaySourceSessionKeys?: readonly string[];
  prepareMessageAfterIdempotencyCheck?: (
    message: PersistedUserTurnMessage,
  ) => PersistedUserTurnMessage | undefined;
  config?: OpenClawConfig;
};

export function preparePendingInputRequest(params: PendingInputRequest) {
  const idempotencyKey = readMessageIdempotencyKey(params.message);
  if (!idempotencyKey || !params.runId) {
    throw new Error("Pending input requires an exact run and message idempotency key");
  }
  return {
    message: params.message,
    runId: params.runId,
    idempotencyKey,
    replaySourceSessionKeys: params.replaySourceSessionKeys,
    ...preparePendingInputMessage(params.message, params.requestFingerprint),
  };
}

/** Reconcile only a shipped scheduling-source variation against its complete accepted hash. */
export function resolvePendingInputReplayRequest(
  prepared: ReturnType<typeof preparePendingInputRequest>,
  accepted?: Pick<SessionPendingInputRow, "request_hash" | "run_id">,
) {
  const { message, replaySourceSessionKeys } = prepared;
  const original = {
    message,
    stableMessage: prepared.stableMessage,
    requestHash: prepared.requestHash,
  };
  if (!replaySourceSessionKeys) {
    return original;
  }
  if (
    prepared.requestHash.startsWith("request:") ||
    message.provenance?.kind !== "inter_session" ||
    message.provenance.sourceTool !== "subagent_settle"
  ) {
    throw new Error("Pending input source replay requires an internal settle request");
  }
  if (accepted?.run_id !== prepared.runId || accepted.request_hash === prepared.requestHash) {
    return original;
  }
  // v2026.9.5 keyed the wave but attributed it to the scheduling sibling.
  // Nothing else may vary, and an absent or unmatched receipt authorizes no substitution.
  for (const sourceSessionKey of new Set(replaySourceSessionKeys)) {
    const candidate = { ...message, provenance: { ...message.provenance, sourceSessionKey } };
    const request = preparePendingInputMessage(candidate);
    if (request.requestHash === accepted.request_hash) {
      return { message: candidate, ...request };
    }
  }
  return original;
}

/** Prove committed private input by its approved bytes, while hashing the raw retry. */
export function resolveCommittedPendingInputRequestHash(
  options: PendingInputRequest,
  committedMessage: PersistedUserTurnMessage,
): string | undefined {
  let candidate = preparePendingInputRequest(options);
  if (options.replaySourceSessionKeys) {
    // Consumption retired the raw receipt. The scoped transcript retains
    // the run-bound key and approved bytes, not the original request hash.
    if (candidate.idempotencyKey !== `${options.runId}:user`) {
      throw new Error("Input completion retry conflicts with the accepted run");
    }
    const committedProvenance = committedMessage.provenance;
    const sourceSessionKey = committedProvenance?.sourceSessionKey;
    if (
      !options.message.provenance ||
      committedProvenance?.kind !== "inter_session" ||
      committedProvenance.sourceTool !== "subagent_settle" ||
      !sourceSessionKey ||
      !options.replaySourceSessionKeys.includes(sourceSessionKey)
    ) {
      throw new Error("Input completion committed source is outside the frozen settle cohort");
    }
    // Preparation may erase provenance, so prove the committed source before invoking it.
    candidate = preparePendingInputRequest({
      ...options,
      message: {
        ...options.message,
        provenance: { ...options.message.provenance, sourceSessionKey },
      },
    });
  }
  // Source reconstruction is only a candidate until the whole approved payload matches.
  const prepared = options.prepareMessageAfterIdempotencyCheck
    ? options.prepareMessageAfterIdempotencyCheck(candidate.message)
    : candidate.message;
  if (!prepared) {
    return undefined;
  }
  const { timestamp: _preparedTimestamp, ...stablePrepared } = redactTranscriptMessageForStorage(
    prepared,
    { config: options.config },
  );
  const { timestamp: _committedTimestamp, ...stableCommitted } = committedMessage;
  if (stableStringify(stablePrepared) !== stableStringify(stableCommitted)) {
    throw new Error("Input completion retry conflicts with the committed input");
  }
  return candidate.requestHash;
}

export function matchesSessionPendingInputRequest(
  receipt: Pick<SessionPendingInputRow, "request_hash" | "consumed_event_id">,
  message: Record<string, unknown>,
  requestHash: string,
): boolean {
  if (receipt.request_hash === requestHash) {
    return true;
  }
  // Older collectors retain message-hash receipts. Matching one returns its
  // recorded outcome; it must never reopen pre-upgrade execution custody.
  if (receipt.consumed_event_id == null) {
    return false;
  }
  if (receipt.request_hash === resolvePendingInputRequestHash(message)) {
    return true;
  }
  const metadata = asOptionalRecord(message["__openclaw"]);
  const transport = asOptionalRecord(metadata?.transport);
  if (!metadata || !transport || !Object.hasOwn(transport, "clients")) {
    return false;
  }
  // v2026.9.4 Gateway inputs have no client sources. Preserve every other
  // request field while reconstructing their original serialized shape.
  const legacyTransport = { ...transport };
  delete legacyTransport.clients;
  const legacyMetadata = { ...metadata };
  if (Object.keys(legacyTransport).length) {
    legacyMetadata.transport = legacyTransport;
  } else {
    delete legacyMetadata.transport;
  }
  const legacyMessage = { ...message };
  if (Object.keys(legacyMetadata).length) {
    legacyMessage["__openclaw"] = legacyMetadata;
  } else {
    delete legacyMessage["__openclaw"];
  }
  return receipt.request_hash === resolvePendingInputRequestHash(legacyMessage);
}
