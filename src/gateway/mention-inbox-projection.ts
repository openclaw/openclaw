import {
  MAX_HUMAN_MENTIONS,
  MENTION_INBOX_MAX_ITEMS,
} from "../../packages/gateway-protocol/src/index.js";
import type {
  MentionStoreHead,
  MentionStoreMessage,
  MentionStoreSnapshot,
  MentionStoreSource,
} from "./mention-inbox-store.js";

const MAX_GLOBAL_ITEMS = 10_000;

export type StoredMention = {
  id: string;
  recipientProfileId: string;
  source: ProcessedSource;
  message: MentionStoreMessage;
};

export type ProcessedSource = {
  key: string;
  sequence: number;
  expiresAt: number;
  /** Null retains consumption after dismissal, eviction, or intentional non-delivery. */
  recipients: Map<string, StoredMention | null>;
};

export type InboxState = {
  head: MentionStoreHead;
  items: Map<string, StoredMention>;
  itemsByProfile: Map<string, Set<StoredMention>>;
  processed: Map<string, ProcessedSource>;
  dirtySources: Set<string>;
  nextExpiryAt: number;
  profileVersion: number;
};

export function createMentionProjection(snapshot: MentionStoreSnapshot): InboxState {
  const next: InboxState = {
    head: { ...snapshot.head },
    items: new Map(),
    itemsByProfile: new Map(),
    processed: new Map(),
    dirtySources: new Set(),
    nextExpiryAt: Infinity,
    profileVersion: -1,
  };
  for (const stored of snapshot.sources) {
    const source: ProcessedSource = {
      key: stored.key,
      sequence: stored.sequence,
      expiresAt: stored.expiresAt,
      recipients: new Map(),
    };
    next.processed.set(source.key, source);
    next.nextExpiryAt = Math.min(next.nextExpiryAt, source.expiresAt);
    for (const [profileId, id] of stored.recipients) {
      const item: StoredMention | null =
        id && stored.message
          ? { id, recipientProfileId: profileId, source, message: stored.message }
          : null;
      source.recipients.set(profileId, item);
      if (item) {
        next.items.set(item.id, item);
        indexMentionItem(next, item, false);
      }
    }
  }
  return next;
}

export function createMentionMutationProjection(
  state: InboxState,
  profileIds?: readonly string[],
): {
  draft: InboxState;
  sourceIndex: ReadonlyMap<string, ProcessedSource>;
  itemLimit: number;
  publish: (head: MentionStoreHead) => InboxState;
} {
  if (!profileIds) {
    const draft = createMentionProjection({
      head: state.head,
      sources: [...state.processed.values()].map(serializeMentionSource),
    });
    draft.profileVersion = state.profileVersion;
    return {
      draft,
      sourceIndex: draft.processed,
      itemLimit: MAX_GLOBAL_ITEMS,
      publish(head) {
        draft.head = head;
        draft.dirtySources.clear();
        return draft;
      },
    };
  }
  const draft: InboxState = {
    ...state,
    head: { ...state.head },
    processed: new Map(),
    items: new Map(),
    itemsByProfile: new Map(),
    dirtySources: new Set(),
  };
  const include = (item: StoredMention) => {
    if (draft.items.has(item.id)) {
      return;
    }
    let source = draft.processed.get(item.source.key);
    if (!source) {
      source = { ...item.source, recipients: new Map(item.source.recipients) };
      draft.processed.set(source.key, source);
    }
    const copy = { ...item, source };
    source.recipients.set(item.recipientProfileId, copy);
    draft.items.set(item.id, copy);
    indexMentionItem(draft, copy, false);
  };
  // One input adds at most this many items; cohort evictions also reduce global demand.
  const oldest = state.items.values();
  for (let index = 0; index < MAX_HUMAN_MENTIONS; index++) {
    const item = oldest.next().value;
    if (!item) {
      break;
    }
    include(item);
  }
  for (const profileId of profileIds) {
    for (const item of state.itemsByProfile.get(profileId) ?? []) {
      include(item);
    }
  }
  const omittedItems = state.items.size - draft.items.size;
  return {
    draft,
    sourceIndex: state.processed,
    itemLimit: MAX_GLOBAL_ITEMS - omittedItems,
    publish(head) {
      for (const key of draft.dirtySources) {
        const incoming = draft.processed.get(key);
        const previous = state.processed.get(key);
        if (previous) {
          for (const [profileId, item] of previous.recipients) {
            if (item && incoming?.recipients.get(profileId)?.id !== item.id) {
              removeMentionItem(state, item);
            }
          }
        }
        if (!incoming) {
          state.processed.delete(key);
          continue;
        }
        const source = previous ?? incoming;
        const recipients = new Map<string, StoredMention | null>();
        for (const [profileId, item] of incoming.recipients) {
          const retained = previous?.recipients.get(profileId);
          if (item && retained?.id === item.id) {
            recipients.set(profileId, retained);
          } else {
            recipients.set(profileId, item);
            if (item) {
              item.source = source;
              state.items.set(item.id, item);
              indexMentionItem(state, item, false);
            }
          }
        }
        source.recipients = recipients;
        source.sequence = incoming.sequence;
        source.expiresAt = incoming.expiresAt;
        state.processed.set(key, source);
      }
      state.head = head;
      state.nextExpiryAt = draft.nextExpiryAt;
      state.profileVersion = draft.profileVersion;
      state.dirtySources.clear();
      return state;
    },
  };
}

export function serializeMentionSource(source: ProcessedSource): MentionStoreSource {
  const message = [...source.recipients.values()].find((item) => item !== null)?.message;
  return {
    key: source.key,
    sequence: source.sequence,
    expiresAt: source.expiresAt,
    recipients: [...source.recipients].map(([profileId, item]) => [profileId, item?.id ?? null]),
    ...(message ? { message } : {}),
  };
}
export function removeMentionItem(draft: InboxState, item: StoredMention | null | undefined): void {
  const { items, itemsByProfile, dirtySources } = draft;
  if (!item || !items.delete(item.id)) {
    return;
  }
  const profileItems = itemsByProfile.get(item.recipientProfileId);
  profileItems?.delete(item);
  if (profileItems?.size === 0) {
    itemsByProfile.delete(item.recipientProfileId);
  }
  item.source.recipients.set(item.recipientProfileId, null);
  dirtySources.add(item.source.key);
}

export function trimMentionItems(
  draft: InboxState,
  retained: ReadonlyMap<string, StoredMention> | ReadonlySet<StoredMention>,
  limit: number,
) {
  const oldest = retained.values();
  while (retained.size > limit) {
    removeMentionItem(draft, oldest.next().value);
  }
}

export function indexMentionItem(draft: InboxState, item: StoredMention, trim = true): void {
  const { itemsByProfile } = draft;
  const retained = itemsByProfile.get(item.recipientProfileId) ?? new Set<StoredMention>();
  retained.add(item);
  itemsByProfile.set(item.recipientProfileId, retained);
  if (trim) {
    trimMentionItems(draft, retained, MENTION_INBOX_MAX_ITEMS);
  }
}

export function expireMentionItems(draft: InboxState, now: number): void {
  const { processed, dirtySources, nextExpiryAt } = draft;
  // Retention is bounded, but scanning it on every read and delivery makes a burst quadratic.
  if (now < nextExpiryAt) {
    return;
  }
  let next = Infinity;
  for (const [key, source] of processed) {
    if (source.expiresAt > now) {
      next = Math.min(next, source.expiresAt);
      continue;
    }
    for (const item of source.recipients.values()) {
      removeMentionItem(draft, item);
    }
    processed.delete(key);
    dirtySources.add(key);
  }
  draft.nextExpiryAt = next;
}

export function reconcileMentionProfiles(
  draft: InboxState,
  version: number,
  canonicalProfileId: (id: string) => string,
): void {
  const { processed, dirtySources, items, itemsByProfile } = draft;
  if (version === draft.profileVersion) {
    return;
  }
  draft.profileVersion = version;
  for (const source of processed.values()) {
    const recipients = new Map<string, StoredMention | null>();
    for (const [profileId, item] of source.recipients) {
      const canonical = canonicalProfileId(profileId);
      if (canonical !== profileId || recipients.has(canonical)) {
        dirtySources.add(source.key);
      }
      if (!recipients.has(canonical)) {
        recipients.set(canonical, item);
        if (item) {
          item.recipientProfileId = canonical;
        }
        continue;
      }
      const previous = recipients.get(canonical);
      // An acknowledgement remains acknowledged when two aliases become one person.
      if (item === null && previous) {
        items.delete(previous.id);
        recipients.set(canonical, null);
      } else if (item) {
        items.delete(item.id);
      }
    }
    source.recipients = recipients;
  }
  itemsByProfile.clear();
  for (const item of items.values()) {
    // An unresolved display can mean a transient read failure, not a deleted profile.
    // Current authorization hides it; original retention still owns durable deletion.
    indexMentionItem(draft, item);
  }
}
