import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";

type SystemAgentSessionCollection = ReadonlyMap<string, unknown>;

const systemAgentSessionQueues = new WeakMap<SystemAgentSessionCollection, KeyedAsyncQueue>();

export function getSystemAgentSessionQueue(
  sessions: SystemAgentSessionCollection,
): KeyedAsyncQueue {
  let queue = systemAgentSessionQueues.get(sessions);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    systemAgentSessionQueues.set(sessions, queue);
  }
  return queue;
}
