import { createHash, randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { createHumanMentionPolicy } from "./human-mention-policy.js";
import type { MentionCommittedInput } from "./mention-inbox-input.js";
import { formatMentionExcerpt } from "./mention-inbox-presentation.js";
import {
  indexMentionItem,
  trimMentionItems,
  type createMentionMutationProjection,
  type InboxState,
  type ProcessedSource,
  type StoredMention,
} from "./mention-inbox-projection.js";
import { MAX_MENTION_SOURCES, MENTION_RETENTION_MS } from "./mention-inbox-store.js";
import { resolveSessionSharingTarget } from "./session-sharing.js";

const log = createSubsystemLogger("gateway/mentions");

export function createMentionInputRecorder(params: {
  getRuntimeConfig: () => OpenClawConfig;
  now: () => number;
  policy: ReturnType<typeof createHumanMentionPolicy>;
  onCapacityReached: () => void;
}) {
  const { policy } = params;
  return function applyCommittedInput(
    input: MentionCommittedInput,
    draft: InboxState,
    guards: Array<() => void>,
    bounds: Pick<ReturnType<typeof createMentionMutationProjection>, "sourceIndex" | "itemLimit">,
  ): StoredMention[] {
    if (isIncognitoSessionKey(input.sessionKey)) {
      return [];
    }
    const { processed, head, dirtySources, items } = draft;
    const cfg = params.getRuntimeConfig();
    const resolved = resolveSessionSharingTarget({
      cfg,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
    });
    if (
      !resolved ||
      resolved.entry.sessionId !== input.sessionId ||
      resolved.entry.incognito === true ||
      isIncognitoSessionKey(resolved.canonicalKey)
    ) {
      log.debug("Skipped mention delivery because its committed session changed.");
      return [];
    }
    guards.push(() => {
      const current = resolveSessionSharingTarget({
        cfg: params.getRuntimeConfig(),
        sessionKey: input.sessionKey,
        agentId: input.agentId,
      });
      if (
        !current ||
        current.entry.sessionId !== input.sessionId ||
        current.entry.incognito === true ||
        current.canonicalKey !== resolved.canonicalKey ||
        current.storePath !== resolved.storePath ||
        current.entry.visibility !== resolved.entry.visibility
      ) {
        throw new Error("Committed mention session changed before commit");
      }
    });
    const sourceKey = createHash("sha256")
      .update(
        JSON.stringify([resolved.agentId, resolved.canonicalKey, input.sessionId, input.sourceId]),
      )
      .digest("hex");
    if (bounds.sourceIndex.has(sourceKey)) {
      return [];
    }
    // Never evict consumption early to make room: doing so could re-alert a dismissed message.
    if (bounds.sourceIndex.size >= MAX_MENTION_SOURCES) {
      params.onCapacityReached();
      return [];
    }
    const now = params.now();
    const source: ProcessedSource = {
      key: sourceKey,
      sequence: head.nextSequence++,
      expiresAt: now + MENTION_RETENTION_MS,
      recipients: new Map(),
    };
    processed.set(sourceKey, source);
    dirtySources.add(sourceKey);
    draft.nextExpiryAt = Math.min(draft.nextExpiryAt, source.expiresAt);
    const sender = policy.readProfile(input.senderProfileId);
    const target = {
      agentId: resolved.agentId,
      sessionKey: resolved.canonicalKey,
      entry: resolved.entry,
    };
    const excerpt = formatMentionExcerpt(input.excerpt);
    // Recipients share immutable message data; consumed sources retain only replay tombstones.
    const message: StoredMention["message"] = {
      sessionId: input.sessionId,
      content: {
        senderProfileId: sender?.profileId ?? input.senderProfileId,
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        messageId: input.messageId,
        createdAt: now,
        ...(excerpt ? { excerpt } : {}),
      },
    };
    const created: StoredMention[] = [];
    let unavailableRecipients = 0;
    for (const profileId of input.recipientProfileIds) {
      const recipient = policy.recipientProfile(profileId, target, cfg);
      const canonicalId = recipient?.profileId ?? profileId;
      if (source.recipients.has(canonicalId)) {
        continue;
      }
      source.recipients.set(canonicalId, null);
      if (!sender || !recipient || sender.profileId === recipient.profileId) {
        unavailableRecipients += 1;
        continue;
      }
      const item: StoredMention = {
        id: randomUUID(),
        recipientProfileId: recipient.profileId,
        source,
        message,
      };
      items.set(item.id, item);
      source.recipients.set(recipient.profileId, item);
      indexMentionItem(draft, item);
      trimMentionItems(draft, items, bounds.itemLimit);
      created.push(item);
    }
    if (unavailableRecipients > 0) {
      log.debug(
        `Skipped ${unavailableRecipients} unavailable mention recipients for committed input.`,
      );
    }
    return created;
  };
}
