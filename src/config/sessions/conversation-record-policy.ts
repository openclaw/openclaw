import type { ConversationRecord } from "./conversation-registry.types.js";

export function normalizeStoredConversationRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^conv_[a-f0-9]{32}$/u.test(normalized)) {
    throw new Error(`Invalid conversationRef: ${value}`);
  }
  return normalized;
}

export type MappedConversationRow = {
  associationIsCurrent: boolean;
  record: ConversationRecord;
};

/** Newest activity orders the catalogue; current associations own its routing facts. */
export function selectUniqueConversationRows<Row>(
  rows: Iterable<Row>,
  options: {
    conversationRef(row: Row): string;
    map(row: Row): MappedConversationRow | null;
    limit?: number;
  },
): ConversationRecord[] {
  const unique = new Map<string, MappedConversationRow>();
  for (const row of rows) {
    const existing = unique.get(options.conversationRef(row));
    if (existing?.associationIsCurrent) {
      continue;
    }
    const mapped = options.map(row);
    if (!mapped) {
      continue;
    }
    if (!existing) {
      unique.set(mapped.record.conversationRef, mapped);
      continue;
    }
    if (
      mapped.associationIsCurrent &&
      mapped.record.sessionId &&
      mapped.record.sessionKey &&
      mapped.record.role
    ) {
      const {
        routeContext: _context,
        routeContextObserved: _observed,
        ...previous
      } = existing.record;
      unique.set(mapped.record.conversationRef, {
        associationIsCurrent: true,
        record: {
          ...previous,
          sessionId: mapped.record.sessionId,
          sessionKey: mapped.record.sessionKey,
          role: mapped.record.role,
          ...(mapped.record.routeContextObserved ? { routeContextObserved: true as const } : {}),
          ...(mapped.record.routeContext ? { routeContext: mapped.record.routeContext } : {}),
        },
      });
    }
  }
  const values = [...unique.values()].map(({ record }) => record);
  return options.limit === undefined ? values : values.slice(0, options.limit);
}
