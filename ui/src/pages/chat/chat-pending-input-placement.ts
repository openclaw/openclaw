import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ChatMessageRecovery } from "./chat-message-recovery.ts";
import { buildPendingInputItems } from "./chat-pending-inputs.ts";
import {
  insertChatItemsByTimestamp,
  messageMatchesSearchQuery,
  type TurnInsertionBounds,
} from "./chat-thread-items.ts";
import { chatItemStartsUserTurn } from "./chat-turn-boundary.ts";
import { isAssistantReplyForRun } from "./terminal-message-identity.ts";

export type PendingInputPlacement = {
  inputId?: string;
  historyAfterKey: string | null;
  historyBeforeKey?: string;
};
// Map order is the observed input sequence, including hidden and promoted inputs.
const MAX_PENDING_INPUT_PLACEMENTS = 200;

type PendingInputProjection = {
  inputId: string;
  items: ChatItem[];
  bounds: TurnInsertionBounds;
};

export function projectPendingInputItems({
  pendingInputs,
  items,
  historyItems,
  historySourceKeys,
  pendingInputPlacements,
  searchQuery,
  queue,
  workspaceSyncPendingRunIds,
  workerSetupPending,
  messageRecovery,
}: {
  pendingInputs: ChatPendingInputsPage["items"];
  items: ChatItem[];
  historyItems: ChatItem[];
  historySourceKeys: ReadonlyMap<string, string>;
  pendingInputPlacements: Map<string, PendingInputPlacement>;
  searchQuery?: string;
  queue?: ChatQueueItem[];
  workspaceSyncPendingRunIds?: readonly string[];
  workerSetupPending?: boolean;
  messageRecovery?: ChatMessageRecovery;
}): PendingInputProjection[] {
  const sourceKey = (key: string) => historySourceKeys.get(key) ?? key;
  const historyIndexes = new Map(historyItems.map((item, index) => [item.key, index]));
  const historyKeysById = new Map(
    historyItems.flatMap((item) => {
      const identity = item.kind === "message" ? readSessionMessageIdentity(item.message) : null;
      return identity?.id && !identity.isImported ? [[identity.id, item.key] as const] : [];
    }),
  );
  // Forwarded inputs become assistant display rows on promotion, so their
  // transcript key changes while the custody producer's durable ID stays fixed.
  const promotedKeys = new Map<string, string>();
  for (const [key, placement] of pendingInputPlacements) {
    const promoted = placement.inputId ? historyKeysById.get(placement.inputId) : undefined;
    if (promoted) {
      promotedKeys.set(key, promoted);
      historyIndexes.set(key, historyIndexes.get(promoted)!);
    }
  }
  const groups = new Map<string, { items: ChatItem[]; inputId: string }>();
  const replyHistoryIndexes = new Map<string, number>();
  for (const input of pendingInputs) {
    const group = buildPendingInputItems(
      [input],
      undefined,
      queue,
      workspaceSyncPendingRunIds,
      workerSetupPending,
      messageRecovery,
    );
    const runId = input.runId;
    if (group[0] && runId) {
      // Custody takes over the local prompt's recovery ceiling, including while
      // search hides that input but leaves an earlier observed handoff visible.
      const replyIndex = historyItems.findIndex(
        (item) => item.kind === "message" && isAssistantReplyForRun(item.message, runId),
      );
      if (replyIndex >= 0) {
        replyHistoryIndexes.set(group[0].key, replyIndex);
      }
    }
    if (
      group[0] &&
      (!searchQuery?.trim() ||
        messageMatchesSearchQuery(input.message, searchQuery, messageRecovery))
    ) {
      groups.set(group[0].key, { items: group, inputId: input.id });
    }
  }
  // First display keeps the existing timestamp order after saved history/local
  // sends. Once displayed, producer identity and observed order own placement.
  const unseen: ChatItem[] = [];
  insertChatItemsByTimestamp(
    unseen,
    [...groups].flatMap(([key, group]) =>
      pendingInputPlacements.has(key) ? [] : [{ item: group.items[0]! }],
    ),
  );
  const order = [...pendingInputPlacements.keys(), ...unseen.map((item) => item.key)];
  const projections: PendingInputProjection[] = [];
  let precedingHistoryIndex = -1;
  let precedingVisibleIndex = -1;
  for (const [orderIndex, key] of order.entries()) {
    const known = pendingInputPlacements.get(key);
    precedingHistoryIndex = Math.max(
      precedingHistoryIndex,
      historyIndexes.get(key) ?? -1,
      known?.historyAfterKey ? (historyIndexes.get(known.historyAfterKey) ?? -1) : -1,
    );
    const visibleIndex = items.findIndex((item) => item.key === (promotedKeys.get(key) ?? key));
    precedingVisibleIndex = Math.max(precedingVisibleIndex, visibleIndex);
    const group = groups.get(key);
    if (!group) {
      continue;
    }
    const placement = pendingInputPlacements.get(key);
    if (!placement) {
      projections.push({ ...group, bounds: { afterKey: items.at(-1)?.key } });
      continue;
    }
    const floor = Math.max(
      precedingHistoryIndex,
      placement.historyAfterKey === null
        ? -1
        : (historyIndexes.get(placement.historyAfterKey) ?? -1),
    );
    const floorPresent =
      placement.historyAfterKey === null ||
      historyIndexes.has(placement.historyAfterKey) ||
      precedingHistoryIndex >= 0;
    let ceiling = floorPresent
      ? historyItems.findIndex((item, index) => index > floor && chatItemStartsUserTurn(item))
      : -1;
    const followingKeys = new Set(
      order.slice(orderIndex + 1).map((next) => promotedKeys.get(next) ?? next),
    );
    const fixedCeiling = placement.historyBeforeKey
      ? historyIndexes.get(placement.historyBeforeKey)
      : undefined;
    for (const candidate of [
      fixedCeiling,
      replyHistoryIndexes.get(key),
      ...order.slice(orderIndex + 1).flatMap((next) => {
        const anchor = pendingInputPlacements.get(next)?.historyBeforeKey;
        return [
          historyIndexes.get(next),
          anchor ? historyIndexes.get(anchor) : undefined,
          replyHistoryIndexes.get(next),
        ];
      }),
    ]) {
      if (candidate !== undefined && candidate > floor && (ceiling < 0 || candidate < ceiling)) {
        ceiling = candidate;
      }
    }
    if (floorPresent || ceiling >= 0) {
      // Canonical promotions advance the source floor, so its position survives
      // later eviction of an old observed input from the bounded sequence.
      placement.historyAfterKey = historyItems[floor]?.key ?? null;
    }
    const observedFloor = Math.max(
      precedingVisibleIndex,
      items.findLastIndex((item) => {
        const index = historyIndexes.get(sourceKey(item.key));
        return index !== undefined && index <= floor;
      }),
    );
    const beforeIndex = items.findIndex((item, index) => {
      const sourceIndex = historyIndexes.get(sourceKey(item.key));
      return (
        (ceiling >= 0 && sourceIndex !== undefined && sourceIndex >= ceiling) ||
        followingKeys.has(item.key) ||
        (index > observedFloor && sourceIndex === undefined && chatItemStartsUserTurn(item))
      );
    });
    const visibleFloor = Math.max(
      precedingVisibleIndex,
      items.findLastIndex((item, index) => {
        const sourceIndex = historyIndexes.get(sourceKey(item.key));
        return (
          sourceIndex !== undefined &&
          (ceiling < 0 || sourceIndex < ceiling) &&
          (beforeIndex < 0 || index < beforeIndex)
        );
      }),
    );
    projections.push({
      ...group,
      bounds: {
        afterKey: items[visibleFloor]?.key,
        beforeKey: beforeIndex < 0 ? undefined : items[beforeIndex]?.key,
      },
    });
  }
  return projections;
}

export function insertPendingInputProjections(
  items: ChatItem[],
  projections: PendingInputProjection[],
): void {
  let precedingGroupKey: string | undefined;
  for (const { items: group, bounds } of projections) {
    const [message, ...notices] = group;
    if (!message) {
      continue;
    }
    const precedingIndex = items.findIndex((item) => item.key === precedingGroupKey);
    const floorIndex = items.findIndex((item) => item.key === bounds.afterKey);
    insertChatItemsByTimestamp(items, [
      {
        item: message,
        bounds: precedingIndex > floorIndex ? { ...bounds, afterKey: precedingGroupKey } : bounds,
      },
    ]);
    // A custody record's status is not a separately clocked row.
    items.splice(items.indexOf(message) + 1, 0, ...notices);
    precedingGroupKey = group.at(-1)?.key;
  }
}

export function observePendingInputOrder(
  items: ChatItem[],
  localInputKeys: ReadonlySet<string>,
  projections: PendingInputProjection[],
  historyItems: ChatItem[],
  historySourceKeys: ReadonlyMap<string, string>,
  placements: Map<string, PendingInputPlacement>,
): void {
  const inputKeys = new Set([
    ...localInputKeys,
    ...projections.flatMap((projection) => (projection.items[0] ? [projection.items[0].key] : [])),
  ]);
  const observed = items.filter((item) => inputKeys.has(item.key));
  const inputIds = new Map(
    projections.flatMap((projection) =>
      projection.items[0] ? [[projection.items[0].key, projection.inputId] as const] : [],
    ),
  );
  const order = [...placements.keys()];
  for (const [index, item] of observed.entries()) {
    const known = placements.has(item.key);
    const inputId = inputIds.get(item.key) ?? placements.get(item.key)?.inputId;
    if (known && !localInputKeys.has(item.key)) {
      placements.get(item.key)!.inputId = inputId;
      continue;
    }
    // Insert a new observation before its next known visible input. Appending
    // otherwise preserves hidden middle inputs and custody pages we cannot see.
    const next = observed.slice(index + 1).find((candidate) => placements.has(candidate.key));
    const nextIndex = next ? order.indexOf(next.key) : -1;
    if (!known) {
      order.splice(nextIndex < 0 ? order.length : nextIndex, 0, item.key);
    }
    const renderedIndex = items.indexOf(item);
    const followingHistory = items
      .slice(renderedIndex + 1)
      .find((candidate) => historySourceKeys.has(candidate.key));
    const renderedHistoryBeforeKey = followingHistory
      ? historySourceKeys.get(followingHistory.key)
      : undefined;
    const renderedHistoryBeforeIndex = historyItems.findIndex(
      (candidate) => candidate.key === renderedHistoryBeforeKey,
    );
    const sendId =
      localInputKeys.has(item.key) && item.kind === "message"
        ? readSessionMessageIdentity(item.message)?.sendId
        : undefined;
    // A filtered-out owned reply is still after its local prompt. Resolve this
    // ceiling before recording the floor, not from the visible search tail.
    const replyIndex = historyItems.findIndex(
      (candidate) =>
        sendId && candidate.kind === "message" && isAssistantReplyForRun(candidate.message, sendId),
    );
    const historyBeforeIndex =
      replyIndex >= 0 && (renderedHistoryBeforeIndex < 0 || replyIndex < renderedHistoryBeforeIndex)
        ? replyIndex
        : renderedHistoryBeforeIndex;
    placements.set(item.key, {
      inputId,
      historyAfterKey:
        historyItems[historyBeforeIndex < 0 ? historyItems.length - 1 : historyBeforeIndex - 1]
          ?.key ?? null,
      historyBeforeKey: historyItems[historyBeforeIndex]?.key,
    });
  }
  const visibleKeys = new Set(observed.map((item) => item.key));
  const inactiveCapacity = Math.max(0, MAX_PENDING_INPUT_PLACEMENTS - visibleKeys.size);
  const inactive = order.filter((key) => !visibleKeys.has(key));
  const retainedKeys = new Set([
    ...visibleKeys,
    ...(inactiveCapacity ? inactive.slice(-inactiveCapacity) : []),
  ]);
  const retained = order
    .filter((key) => retainedKeys.has(key))
    .slice(-MAX_PENDING_INPUT_PLACEMENTS)
    .map((key) => [key, placements.get(key)!] as const);
  placements.clear();
  for (const [key, placement] of retained) {
    placements.set(key, placement);
  }
}
