import { MENTION_INBOX_MAX_ITEMS } from "../../packages/gateway-protocol/src/schema/human-mentions.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { readHumanMentionPolicyInDatabase } from "./human-mention-policy-read.kernel.js";
import { MAX_MENTION_POLICY_PROFILES_PER_READ } from "./human-mention-policy-read.types.js";
import type { MentionStoreSource } from "./mention-inbox-store.codec.js";
import {
  MAX_MENTION_SOURCES,
  MENTION_RETENTION_MS,
  readMentionStoreSnapshotInDatabase,
  writeMentionStoreChanges,
} from "./mention-inbox-store.js";
import type {
  MentionInboxMutation,
  MentionInboxMutationResult,
} from "./mention-inbox.worker-contract.js";

/** One authoritative reread and mutation; host projections never supply replacement store state. */
export function mutateMentionInboxInWorker(
  input: MentionInboxMutation,
  options: OpenClawStateDatabaseOptions,
): MentionInboxMutationResult {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const snapshot = readMentionStoreSnapshotInDatabase(-1, db)!;
      // A different Inbox owner can add recipients after the host snapshot. Resolve
      // their identities from this transaction, never from the host's earlier cohort.
      const profileIds = [
        ...new Set(
          snapshot.sources.flatMap((source) =>
            source.expiresAt > input.now ? source.recipients.map(([id]) => id) : [],
          ),
        ),
      ];
      const aliases = new Map<string, string>();
      for (
        let offset = 0;
        offset < profileIds.length;
        offset += MAX_MENTION_POLICY_PROFILES_PER_READ
      ) {
        const facts = readHumanMentionPolicyInDatabase(db, {
          profileIds: profileIds.slice(offset, offset + MAX_MENTION_POLICY_PROFILES_PER_READ),
          directory: false,
        });
        for (const { requestedId, display } of facts.profiles) {
          aliases.set(requestedId, display.kind === "resolved" ? display.profileId : requestedId);
        }
      }
      const changes = new Map<string, MentionStoreSource | undefined>();
      const sources: MentionStoreSource[] = [];
      const createdIds: string[] = [];
      for (const source of snapshot.sources) {
        if (source.expiresAt <= input.now) {
          changes.set(source.key, undefined);
          continue;
        }
        const original = JSON.stringify(source);
        const recipients = new Map<string, string | null>();
        const excerpts = new Map(
          (source.message?.recipientExcerpts ?? []).map((excerpt) => [excerpt.profileId, excerpt]),
        );
        const retainedExcerpts = new Map<
          string,
          NonNullable<NonNullable<typeof source.message>["recipientExcerpts"]>[number]
        >();
        for (const [profileId, id] of source.recipients) {
          const canonical = aliases.get(profileId) ?? profileId;
          if (!recipients.has(canonical)) {
            recipients.set(canonical, id);
            const excerpt = excerpts.get(profileId);
            if (id && excerpt) {
              retainedExcerpts.set(canonical, { ...excerpt, profileId: canonical });
            }
          } else if (id === null) {
            recipients.set(canonical, null);
            retainedExcerpts.delete(canonical);
          }
        }
        source.recipients = [...recipients];
        if (source.message) {
          source.message.recipientExcerpts = retainedExcerpts.size
            ? [...retainedExcerpts.values()]
            : undefined;
        }
        if (JSON.stringify(source) !== original) {
          changes.set(source.key, source);
        }
        sources.push(source);
      }
      const action = input.action;
      let capacityReached = false;
      if (action.kind === "record" && !sources.some((source) => source.key === action.sourceKey)) {
        if (sources.length >= MAX_MENTION_SOURCES) {
          capacityReached = true;
        } else {
          const recipients = new Map<string, string | null>();
          const excerpts: NonNullable<typeof action.message.recipientExcerpts> = [];
          for (const recipient of action.recipients) {
            if (recipients.has(recipient.profileId)) {
              continue;
            }
            recipients.set(recipient.profileId, recipient.id);
            if (recipient.id) {
              createdIds.push(recipient.id);
              const excerpt = action.message.recipientExcerpts?.find(
                (value) => value.profileId === recipient.excerptProfileId,
              );
              if (excerpt) {
                excerpts.push({ ...excerpt, profileId: recipient.profileId });
              }
            }
          }
          const source: MentionStoreSource = {
            key: action.sourceKey,
            sequence: snapshot.head.nextSequence++,
            expiresAt: input.now + MENTION_RETENTION_MS,
            recipients: [...recipients],
            message: {
              ...action.message,
              content: { ...action.message.content, createdAt: input.now },
              recipientExcerpts: excerpts.length ? excerpts : undefined,
            },
          };
          sources.push(source);
          changes.set(source.key, source);
        }
      }
      const counts = new Map<string, number>();
      let total = 0;
      const dismiss = action.kind === "dismiss" ? new Set(action.ids) : undefined;
      // Retain newest sources exactly as the host's insertion-ordered indexes did.
      for (const source of sources.toReversed()) {
        for (let index = source.recipients.length - 1; index >= 0; index--) {
          const recipient = source.recipients[index]!;
          const [profileId, id] = recipient;
          if (!id) {
            continue;
          }
          const count = counts.get(profileId) ?? 0;
          if (
            (action.kind === "dismiss" && profileId === action.profileId && dismiss?.has(id)) ||
            count >= MENTION_INBOX_MAX_ITEMS ||
            total >= MAX_MENTION_SOURCES
          ) {
            recipient[1] = null;
            changes.set(source.key, source);
          } else {
            counts.set(profileId, count + 1);
            total++;
          }
        }
        if (changes.has(source.key)) {
          const retained = new Set(source.recipients.filter(([, id]) => id).map(([id]) => id));
          if (!retained.size) {
            delete source.message;
          } else if (source.message) {
            const excerpts = source.message.recipientExcerpts?.filter((excerpt) =>
              retained.has(excerpt.profileId),
            );
            source.message.recipientExcerpts = excerpts?.length ? excerpts : undefined;
          }
        }
      }
      const head = writeMentionStoreChanges(db, snapshot.head, changes);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return { snapshot: { head, sources }, createdIds, capacityReached };
    },
    options,
    { operationLabel: "mentions.write" },
  );
}
