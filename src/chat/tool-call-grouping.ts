export type ToolCallIdentity = {
  callId?: string;
  runId?: string;
  parentToolCallId?: string;
};

export type ToolCallGroup<Card = ToolCallIdentity> = {
  card: Card;
  children: ToolCallGroup<Card>[];
};

/** Preserve recorded nesting without guessing relationships from names or arrival order. */
export function groupToolCalls<Card extends ToolCallIdentity>(
  cards: readonly Card[],
): ToolCallGroup<Card>[] {
  const groups = cards.map((card): ToolCallGroup<Card> => ({ card, children: [] }));
  const identities = new Map<string, ToolCallGroup<Card> | null>();
  for (const group of groups) {
    const { runId, callId } = group.card;
    if (runId && callId) {
      const key = JSON.stringify([runId, callId]);
      identities.set(key, identities.has(key) ? null : group);
    }
  }

  const parents = new Map<ToolCallGroup<Card>, ToolCallGroup<Card>>();
  for (const group of groups) {
    const { runId, callId, parentToolCallId } = group.card;
    if (
      !runId ||
      !parentToolCallId ||
      parentToolCallId === callId ||
      (callId && identities.get(JSON.stringify([runId, callId])) !== group)
    ) {
      continue;
    }
    const parent = identities.get(JSON.stringify([runId, parentToolCallId]));
    if (parent) {
      parents.set(group, parent);
    }
  }

  // Break every cycle member out as a root before linking children. Iterative
  // traversal also keeps malformed or deeply nested transcripts stack-safe.
  const visited = new Set<ToolCallGroup<Card>>();
  for (const group of groups) {
    const path: ToolCallGroup<Card>[] = [];
    let current: ToolCallGroup<Card> | undefined = group;
    while (current && !visited.has(current)) {
      visited.add(current);
      path.push(current);
      current = parents.get(current);
    }
    const cycleStart = current ? path.indexOf(current) : -1;
    if (cycleStart >= 0) {
      for (const member of path.slice(cycleStart)) {
        parents.delete(member);
      }
    }
  }

  const roots: ToolCallGroup<Card>[] = [];
  for (const group of groups) {
    const parent = parents.get(group);
    (parent ? parent.children : roots).push(group);
  }
  return roots;
}
