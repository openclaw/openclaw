import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAnnotation,
} from "./user-turn-transcript.types.js";

/** Native annotation extends the admitted message without replacing any source facts. */
export function prepareUserTurnTranscriptAnnotation(
  message: PersistedUserTurnMessage,
  annotation: UserTurnTranscriptAnnotation,
  runId: string,
): PersistedUserTurnMessage {
  const fields = {
    mirrorIdentity: annotation.mirrorIdentity,
    upstreamUserText: annotation.upstreamUserText,
    mirrorOrigin: annotation.mirrorOrigin,
    mirrorSourceFingerprint: annotation.mirrorSourceFingerprint,
    runId,
  };
  if (
    Object.values(fields).some((value) => typeof value !== "string") ||
    !fields.mirrorIdentity ||
    !fields.mirrorOrigin ||
    !fields.mirrorSourceFingerprint
  ) {
    throw new Error("native prompt annotation requires complete provenance");
  }
  const fingerprint = (upstreamUserText: string) =>
    sha256HexPrefixCore(
      JSON.stringify({
        role: "user",
        content: message.content,
        upstreamUserText: upstreamUserText || undefined,
      }),
      32,
    );
  if (fingerprint(fields.upstreamUserText) !== fields.mirrorSourceFingerprint) {
    throw new Error("native prompt annotation does not match admitted content");
  }
  const metadata = message["__openclaw"] ?? {};
  const previous = readUserTurnTranscriptAnnotation(message, runId);
  // A replay starts a new native turn while retaining the exact admitted input.
  const replacesOwnAttempt = Boolean(
    previous?.mirrorIdentity &&
    previous.mirrorOrigin === fields.mirrorOrigin &&
    fingerprint(previous.upstreamUserText) === previous.mirrorSourceFingerprint,
  );
  if (
    metadata.runTerminal !== undefined ||
    (!replacesOwnAttempt &&
      Object.entries(fields).some(
        ([key, value]) => metadata[key] !== undefined && metadata[key] !== value,
      ))
  ) {
    throw new Error("native prompt annotation conflicts with recorded provenance");
  }
  return { ...message, __openclaw: { ...metadata, ...fields } };
}

/** A saved annotation belongs only to its exact admitted run; its bytes still need validation. */
export function readUserTurnTranscriptAnnotation(
  message: PersistedUserTurnMessage,
  runId: string,
): UserTurnTranscriptAnnotation | undefined {
  const metadata = message["__openclaw"];
  if (!metadata || metadata.runId !== runId) {
    return undefined;
  }
  const { mirrorIdentity, upstreamUserText, mirrorOrigin, mirrorSourceFingerprint } = metadata;
  if (
    typeof mirrorIdentity !== "string" ||
    typeof upstreamUserText !== "string" ||
    typeof mirrorOrigin !== "string" ||
    typeof mirrorSourceFingerprint !== "string"
  ) {
    return undefined;
  }
  return { mirrorIdentity, upstreamUserText, mirrorOrigin, mirrorSourceFingerprint };
}
