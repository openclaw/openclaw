import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { compareChatQueueOrder } from "../../lib/chat/chat-queue-order.ts";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ChatMessageRecovery } from "./chat-message-recovery.ts";
import { buildPendingInputItems } from "./chat-pending-inputs.ts";
import { isQueuedSendInlineState, shouldRenderQueuedSendInThread } from "./chat-progress.ts";
import {
  buildMessageItems,
  hasRenderableNormalizedMessage,
  insertChatItemsByTimestamp,
  messageMatchesSearchQuery,
  queuedSendThreadMessage,
} from "./chat-thread-items.ts";
import { selectChatInputDisplay } from "./history-merge.ts";
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
  searchOpen?: boolean;
  searchQuery?: string;
  messageRecovery?: ChatMessageRecovery;
};

/** Canonical history, accepted custody, then local delivery are representations of one input. */
export function placeChatInputs(
  items: ChatItem[],
  history: readonly unknown[],
  props: ChatInputPlacementProps,
  orderState: ChatInputOrderState,
  currentRunId: string | null,
): {
  pendingKeys: Set<string>;
  historicalKeys: Set<string>;
  hiddenKeys: Set<string>;
  activeInputKey?: string;
} {
  const orderedQueue = (props.queue ?? []).toSorted(compareChatQueueOrder);
  const activeSubmission = currentRunId
    ? orderedQueue.find((queued) => queued.sendRunId === currentRunId)
    : undefined;
  const { queue, pendingInputs } = selectChatInputDisplay(
    history,
    orderedQueue,
    props.pendingInputs ?? [],
  );
  const historicalKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const hiddenKeys = new Set<string>();
  const blocks: InputBlock[] = [];
  let activeInputKey: string | undefined;
  let previousStoppedKey: string | undefined;
  const markSearchVisibility = (message: unknown, inputItems: readonly ChatItem[]) => {
    if (
      props.searchOpen &&
      props.searchQuery?.trim() &&
      !messageMatchesSearchQuery(message, props.searchQuery, props.messageRecovery)
    ) {
      for (const item of inputItems) {
        hiddenKeys.add(item.key);
      }
    }
  };
  for (const input of pendingInputs) {
    const inputItems = buildPendingInputItems(
      [input],
      undefined,
      orderedQueue,
      props.workspaceSyncPendingRunIds,
      props.workerSetupPending,
      props.messageRecovery,
    );
    const first = inputItems[0];
    if (!first) {
      continue;
    }
    markSearchVisibility(input.message, inputItems);
    if (input.state === "queued") {
      blocks.push({ items: inputItems, runId: input.runId });
      // Acceptance replaces the local bubble, not its presentation floor.
      if (
        activeSubmission?.sendRunId &&
        input.runId === activeSubmission.sendRunId &&
        !hiddenKeys.has(first.key)
      ) {
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
  const historyKeys = new Set(items.map((item) => item.key));
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
    markSearchVisibility(message, block.items);
    if (
      !activeInputKey &&
      !hiddenKeys.has(block.items[0]!.key) &&
      !isQueuedSendInlineState(queued)
    ) {
      activeInputKey = block.items[0]!.key;
    }
    // Accepted rows keep the Gateway's order. A retained local neighbor provides
    // the insertion point without comparing the browser clock with the Gateway.
    const position = orderedQueue.indexOf(queued);
    const previousPosition = orderState.keys.indexOf(block.items[0]!.key);
    const previousSuccessor =
      previousPosition < 0 || block.initial || block.bypassesQueue
        ? undefined
        : orderState.keys
            .slice(previousPosition + 1)
            .find((key) => acceptedKeys.has(key) || historyKeys.has(key));
    if (previousSuccessor && historyKeys.has(previousSuccessor)) {
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
    // A recovered reply can arrive before its user row. Only exact owned output
    // anchors that local prompt; accepted custody does not imply execution.
    const outputIndex = block.local
      ? items.findIndex((item) => {
          if (!block.runId || item.kind !== "message") {
            return false;
          }
          const identity = readSessionMessageIdentity(item.message);
          return (
            isLiveTerminalForRun(item.message, block.runId) ||
            (identity?.role === "assistant" &&
              !identity.isImported &&
              identity.runId === block.runId)
          );
        })
      : -1;
    const successorIndex = block.beforeKey
      ? items.findIndex((item) => item.key === block.beforeKey)
      : -1;
    const index = block.initial
      ? 0
      : Math.min(
          insertionCeiling,
          outputIndex < 0 ? items.length : outputIndex,
          successorIndex < 0 ? items.length : successorIndex,
        );
    items.splice(index, 0, ...block.items);
    insertionCeiling =
      block.initial || block.bypassesQueue ? insertionCeiling + block.items.length : index;
    pendingKeys.add(block.items[0]!.key);
  }
  // Search hides presentation, not the neighbors that keep an input in place.
  orderState.keys = items
    .filter((item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message))
    .map((item) => item.key);
  return { pendingKeys, historicalKeys, hiddenKeys, activeInputKey };
}
