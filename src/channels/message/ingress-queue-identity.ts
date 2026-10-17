/**
 * Creator-held identity for core ingress queues. Batch and fused admission skip a
 * queue's `enqueue`, so the monitor uses them only on the exact object the core
 * factory returned. A `{ ...queue, enqueue }` wrapper is a different object and
 * therefore admits every event through its own `enqueue`.
 */
const coreQueues = new WeakSet<object>();

/** Records a queue returned by the core factory. */
export function markCoreChannelIngressQueue<TQueue extends object>(queue: TQueue): TQueue {
  coreQueues.add(queue);
  return queue;
}

/** True only for an object returned by the core factory, never for copies of it. */
export function isCoreChannelIngressQueue(queue: object): boolean {
  return coreQueues.has(queue);
}
