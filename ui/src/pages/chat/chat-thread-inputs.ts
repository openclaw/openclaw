import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { compareChatQueueOrder } from "../../lib/chat/chat-queue-order.ts";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { buildPendingInputItems } from "./chat-pending-input-presentation.ts";
import { isQueuedSendInlineState, shouldRenderQueuedSendInThread } from "./chat-progress.ts";
import {
  buildMessageItems,
  hasRenderableNormalizedMessage,
  insertChatItemsByTimestamp,
  queuedSendThreadMessage,
} from "./chat-thread-items.ts";
import { selectChatInputDisplay } from "./history-merge.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";
import { isLiveTerminalForRun } from "./terminal-message-identity.ts";

type InputBlock = {
  items: ChatItem[];
  runId?: string;
  initial?: boolean;
  local?: boolean;
  bypassesQueue?: boolean;
  beforeKey?: string;
};

export type ChatInputOrderState = { keys: string[] };

export type ChatInputPlacementProps = {
  queue?: ChatQueueItem[];
  initialTurnId?: string;
  pendingInputs?: ChatPendingInputsPage["items"];
  workspaceSyncPendingRunIds?: readonly string[];
  workerSetupPending?: boolean;
};

/** Canonical history, accepted custody, then local delivery are representations of one input. */
export function placeChatInputs(
  items: ChatItem[],
  history: readonly unknown[],
  props: ChatInputPlacementProps,
  orderState: ChatInputOrderState,
  currentRunId: string | null,
  hideSearchMiss: (message: unknown, key: string) => void,
) {
  const orderedQueue = (props.queue ?? []).toSorted(compareChatQueueOrder);
  const { queue, pendingInputs } = selectChatInputDisplay(
    history,
    orderedQueue,
    props.pendingInputs ?? [],
  );
  const historicalKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const blocks: InputBlock[] = [];
  let activeInputKey: string | undefined;
  let previousStoppedKey: string | undefined;
  for (const input of pendingInputs) {
    const inputItems = buildPendingInputItems(
      [input],
      props.workspaceSyncPendingRunIds,
      props.workerSetupPending,
    );
    const first = inputItems[0];
    if (!first) {
      continue;
    }
    for (const item of inputItems) {
      hideSearchMiss(input.message, item.key);
    }
    if (input.state === "queued") {
      blocks.push({ items: inputItems, runId: input.runId });
      // On an empty transcript, the first accepted input owns the startup floor
      // even before execution identity arrives. Later inputs remain ceilings.
      if (currentRunId ? input.runId === currentRunId : history.length === 0 && !activeInputKey) {
        activeInputKey = first.key;
      }
      continue;
    }
    // A stopped input is historical. Its disposition travels with the message,
    // and the Gateway's sequence wins over wall-clock changes between inputs.
    insertChatItemsByTimestamp(items, [{ item: first, bounds: { afterKey: previousStoppedKey } }]);
    items.splice(items.indexOf(first) + 1, 0, ...inputItems.slice(1));
    for (const item of inputItems) {
      historicalKeys.add(item.key);
    }
    previousStoppedKey = inputItems.at(-1)!.key;
  }

  const acceptedBlocks = new Map(
    blocks.flatMap((block) => (block.runId ? [[block.runId, block] as const] : [])),
  );
  const acceptedKeys = new Map(blocks.map((block) => [block.items[0]!.key, block]));
  const historyItems = new Map(items.map((item) => [item.key, item]));
  const newLocalInput = blocks.length
    ? items.find((item) => {
        const identity = item.kind === "message" ? readSessionMessageIdentity(item.message) : null;
        return (
          identity?.role === "user" &&
          identity.sendId &&
          identity.id === null &&
          identity.sequence === null &&
          !identity.isImported &&
          !orderState.keys.includes(item.key)
        );
      })
    : undefined;
  for (const block of blocks) {
    const previousPosition = orderState.keys.indexOf(block.items[0]!.key);
    if (previousPosition >= 0) {
      // Custody can replace a steer before younger optimistic inputs settle.
      // Keep its observed input successor without treating custody as run output.
      block.beforeKey =
        orderState.keys.slice(previousPosition + 1).find((key) => {
          const item = historyItems.get(key);
          return (
            item?.kind === "message" && readSessionMessageIdentity(item.message)?.role === "user"
          );
        }) ??
        // An ACK can arrive before the next local send has a previous position.
        newLocalInput?.key;
    }
  }
  for (const queued of queue) {
    if (!shouldRenderQueuedSendInThread(queued)) {
      continue;
    }
    const message = queuedSendThreadMessage(queued);
    if (!message) {
      continue;
    }
    const block: InputBlock = {
      items: [
        {
          kind: "message",
          key: queued.sendRunId
            ? buildMessageItems([message])[0]!.key
            : `pending-send:${queued.id}`,
          message,
        },
      ],
      runId: queued.sendRunId,
      initial: queued.id === props.initialTurnId,
      local: true,
      bypassesQueue: queued.queueMode === "steer" || queued.queueMode === "interrupt",
    };
    hideSearchMiss(message, block.items[0]!.key);
    if (!activeInputKey && !isQueuedSendInlineState(queued)) {
      activeInputKey = block.items[0]!.key;
    }
    // Accepted rows keep the Gateway's order. A retained local neighbor provides
    // the insertion point without comparing the browser clock with the Gateway.
    const position = orderedQueue.indexOf(queued);
    const previousPosition = orderState.keys.indexOf(block.items[0]!.key);
    const previousSuccessor =
      previousPosition < 0 || block.initial
        ? undefined
        : orderState.keys
            .slice(previousPosition + 1)
            .find((key) => acceptedKeys.has(key) || historyItems.has(key));
    if (previousSuccessor && historyItems.has(previousSuccessor)) {
      block.beforeKey = previousSuccessor;
    }
    const nextAccepted =
      orderedQueue
        .slice(position + 1)
        .map((candidate) =>
          candidate.sendRunId ? acceptedBlocks.get(candidate.sendRunId) : undefined,
        )
        .find((candidate) => candidate !== undefined) ??
      // A successor keeps its key through custody and canonical promotion.
      (previousSuccessor ? acceptedKeys.get(previousSuccessor) : undefined);
    const index = nextAccepted ? blocks.indexOf(nextAccepted) : -1;
    blocks.splice(index < 0 ? blocks.length : index, 0, block);
  }

  let insertionCeiling = items.length;
  for (const block of blocks.toReversed()) {
    let index = block.initial ? 0 : insertionCeiling;
    let hasOwnedOutput = false;
    for (const [at, item] of items.entries()) {
      // A steer can bypass older custody only if its own output exists, even
      // beyond the insertion ceiling. Other inputs need only their first anchor.
      if (at >= index && (block.initial || !block.bypassesQueue)) {
        break;
      }
      if (block.beforeKey && item.key === block.beforeKey) {
        index = Math.min(index, at);
      }
      if (!block.runId || item.kind !== "message") {
        continue;
      }
      const identity = readSessionMessageIdentity(item.message);
      if (
        block.local &&
        (isLiveTerminalForRun(item.message, block.runId) ||
          (identity?.role === "assistant" &&
            !identity.isImported &&
            identity.runId === block.runId))
      ) {
        hasOwnedOutput = true;
        index = Math.min(index, at);
        break;
      }
      // A persisted steer keeps its original input ahead of it without relying on either clock.
      if (
        identity?.role === "user" &&
        !identity.isImported &&
        persistedSteerTargetRunId(item.message) === block.runId
      ) {
        index = Math.min(index, at);
      }
    }
    items.splice(index, 0, ...block.items);
    // Steering can precede queued work when its own recovered reply anchors it
    // there. The delivery mode alone must not reverse pending submissions at
    // the live edge while their acknowledgments are still outstanding.
    insertionCeiling =
      block.initial || (block.bypassesQueue && hasOwnedOutput)
        ? insertionCeiling + block.items.length
        : index;
    pendingKeys.add(block.items[0]!.key);
  }
  // Search hides presentation, not the neighbors that keep an input in place.
  orderState.keys = items
    .filter((item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message))
    .map((item) => item.key);
  return { pendingKeys, historicalKeys, activeInputKey };
}
