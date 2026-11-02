import { isSessionParticipantIdentity } from "../../packages/gateway-protocol/src/compiled/sender-identity.js";
import type { SessionParticipantIdentity } from "../../packages/gateway-protocol/src/schema/session-participant.js";

export type TranscriptSenderIdentity = Extract<
  SessionParticipantIdentity,
  { type: "profile" | "remote" | "observation" }
>;

/** Transcript attribution uses the closed product vocabulary, never raw-id inference. */
export function readTranscriptSenderIdentity(value: unknown): TranscriptSenderIdentity | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !isSessionParticipantIdentity(value) ||
    (value.type !== "profile" && value.type !== "remote" && value.type !== "observation") ||
    Object.values(value).some((part) => part !== null && (!part.trim() || part.length > 512))
  ) {
    return undefined;
  }
  return { ...value };
}
