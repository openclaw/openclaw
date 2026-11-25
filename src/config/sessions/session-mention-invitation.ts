import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { updateSessionProfileInvolvementInTransaction } from "./session-accessor.sqlite-involvement.worker.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { SessionMentionInvitationCommit } from "./session-sharing-authority.types.js";

/** Called only after a fresh original insert, before the transcript transaction commits. */
export function applySessionMentionInvitationsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  { message, invitations, source }: SessionMentionInvitationCommit,
): boolean {
  if (!isRecord(message) || message.role !== "user" || typeof message.timestamp !== "number") {
    return false;
  }
  const metadata = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
  if (
    message.display === false ||
    message.excludeFromContext === true ||
    (isRecord(message.provenance) && message.provenance.kind !== "external_user") ||
    metadata?.lateMedia === true ||
    metadata?.beforeAgentRunBlocked !== undefined ||
    !Array.isArray(metadata?.humanMentions)
  ) {
    return false;
  }
  const mentions = metadata.humanMentions;
  const text =
    extractTextFromChatContent(message.content, {
      joinWith: "\n",
      normalizeText: (value) => value,
    }) ?? "";
  let changed = false;
  for (const invitation of invitations) {
    const profiles = invitation.profiles.filter((profile) =>
      mentions.some(
        (mention: unknown) =>
          isRecord(mention) &&
          typeof mention.profileId === "string" &&
          profile.aliases.includes(mention.profileId) &&
          typeof mention.start === "number" &&
          typeof mention.end === "number" &&
          profile.tokens.includes(text.slice(mention.start, mention.end)),
      ),
    );
    if (!profiles.length) {
      continue;
    }
    const profileIds = profiles.map(({ profileId }) => profileId);
    const result = updateSessionProfileInvolvementInTransaction(
      database,
      scope,
      {
        expectedSessionId: scope.sessionId,
        profileIds,
        change: {
          kind: "mention",
          source: {
            generation: source.generation,
            sequence: source.rawSeq,
            timestamp: message.timestamp,
          },
          invitation: {
            addedBy: invitation.addedBy,
            profileIds,
            expectedEntry: invitation.expectedEntry,
          },
        },
      },
      profiles,
    );
    if (!result.accepted) {
      throw new Error("Session changed before the mention invitation could commit");
    }
    changed ||= result.changed;
  }
  return changed;
}
