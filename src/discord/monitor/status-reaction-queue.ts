type QueueLaneSnapshot = {
  channelId: string;
  messageIds: string[];
};

type QueueSnapshot = {
  size: number;
  lanes: QueueLaneSnapshot[];
};

const lanes = new Map<string, string[]>();
const laneWaiters = new Map<string, Map<string, Set<() => void>>>();

function normalizeChannelId(channelId: string): string {
  return channelId.trim();
}

function normalizeMessageId(messageId: string): string {
  return messageId.trim();
}

function resolveWaiters(channelId: string, messageId: string): void {
  const channelWaiters = laneWaiters.get(channelId);
  if (!channelWaiters) {
    return;
  }
  const waiters = channelWaiters.get(messageId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  channelWaiters.delete(messageId);
  if (channelWaiters.size === 0) {
    laneWaiters.delete(channelId);
  }
  for (const resolve of waiters) {
    resolve();
  }
}

function notifyHeadWaiters(channelId: string): void {
  const lane = lanes.get(channelId);
  if (!lane || lane.length === 0) {
    return;
  }
  const head = lane[0];
  if (!head) {
    return;
  }
  resolveWaiters(channelId, head);
}

/**
 * Claim a queue slot for a Discord message lifecycle within a channel lane.
 * hasPriorPendingWork means this message is not first in that lane.
 */
export function claimDiscordStatusReactionQueue(
  channelId: string,
  messageId: string,
): {
  hasPriorPendingWork: boolean;
  position: number;
} {
  const laneKey = normalizeChannelId(channelId);
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!laneKey || !normalizedMessageId) {
    return { hasPriorPendingWork: false, position: 0 };
  }

  const lane = lanes.get(laneKey) ?? [];
  let position = lane.indexOf(normalizedMessageId);
  if (position < 0) {
    lane.push(normalizedMessageId);
    position = lane.length - 1;
  }
  lanes.set(laneKey, lane);
  if (position === 0) {
    notifyHeadWaiters(laneKey);
  }
  return {
    hasPriorPendingWork: position > 0,
    position,
  };
}

/**
 * Wait until this claimed message reaches the head of its channel lane.
 */
export function waitForDiscordStatusReactionQueueTurn(
  channelId: string,
  messageId: string,
): Promise<void> {
  const laneKey = normalizeChannelId(channelId);
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!laneKey || !normalizedMessageId) {
    return Promise.resolve();
  }

  const lane = lanes.get(laneKey);
  if (!lane) {
    return Promise.resolve();
  }
  const position = lane.indexOf(normalizedMessageId);
  if (position <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let channelWaiters = laneWaiters.get(laneKey);
    if (!channelWaiters) {
      channelWaiters = new Map<string, Set<() => void>>();
      laneWaiters.set(laneKey, channelWaiters);
    }
    let waiters = channelWaiters.get(normalizedMessageId);
    if (!waiters) {
      waiters = new Set<() => void>();
      channelWaiters.set(normalizedMessageId, waiters);
    }
    waiters.add(resolve);
  });
}

/**
 * Release a previously claimed queue slot.
 */
export function releaseDiscordStatusReactionQueue(channelId: string, messageId: string): void {
  const laneKey = normalizeChannelId(channelId);
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!laneKey || !normalizedMessageId) {
    return;
  }
  const lane = lanes.get(laneKey);
  if (!lane) {
    return;
  }
  const nextLane = lane.filter((entry) => entry !== normalizedMessageId);
  resolveWaiters(laneKey, normalizedMessageId);
  if (nextLane.length === 0) {
    lanes.delete(laneKey);
    laneWaiters.delete(laneKey);
    return;
  }
  lanes.set(laneKey, nextLane);
  notifyHeadWaiters(laneKey);
}

function getQueueSnapshot(): QueueSnapshot {
  const laneEntries = Array.from(lanes.entries())
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([channelId, messageIds]) => ({ channelId, messageIds: [...messageIds] }));
  return {
    size: laneEntries.reduce((sum, lane) => sum + lane.messageIds.length, 0),
    lanes: laneEntries,
  };
}

function resetQueueForTests(): void {
  lanes.clear();
  laneWaiters.clear();
}

export const __testing = {
  getQueueSnapshot,
  resetQueueForTests,
};
