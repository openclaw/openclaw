/**
 * Queue System - Main Entry Point
 * Exports all queue functionality for easy importing
 */

export {
  RedisQueueBackend,
  type QueueConfig,
  type WorkerConfig,
} from './redisQueue.js';

export {
  QueueWorker,
  startWorker,
  runWorkerAsStandalone,
} from './worker.js';

export {
  initProducer,
  stopProducer,
  isProducerReady,
  enqueueMessage,
  enqueueRawMessage,
  getQueueDepth,
  getMessage,
} from './producer.js';

export {
  determinePriority,
  isAdminUser,
  isOwnerUser,
  getPriorityRules,
  calculatePriorityScore,
  parsePriorityScore,
} from './prioritizer.js';

export {
  emitWebhookEvent,
  validateWebhookSignature,
  testWebhook,
} from './webhooks.js';

export {
  dispatchMessageToAgent,
  processMessageInline,
  formatQueuedMessageForLog,
} from './agent-dispatcher.js';

export {
  ATOMIC_DEQUEUE_SCRIPT,
  CLEAR_QUEUE_SCRIPT,
} from './lua-scripts.js';

export type {
  ChannelType,
  WebhookEventType,
  MediaFile,
  QueuedMessage,
  PriorityRule,
  WebhookConfig,
  WebhookEventPayload,
  MessageProcessingResult,
  DeadLetterEntry,
} from './types.js';
