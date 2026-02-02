/**
 * Redis Queue Backend
 * Manages Redis data structures for message queuing
 */

import { createClient, type RedisClientType } from 'redis';
import type { QueuedMessage, DeadLetterEntry, QueueConfig } from './types.js';
import { calculatePriorityScore } from './prioritizer.js';
import { ATOMIC_DEQUEUE_SCRIPT, CLEAR_QUEUE_SCRIPT } from './lua-scripts.js';

const DEFAULT_KEY_PREFIX = 'openclaw:queue';
const DEFAULT_QUEUE_KEY = 'all';
const DEFAULT_DLQ_KEY = 'dlq';
const DEFAULT_PROCESSING_STREAM = 'processing';

/**
 * Sanitize Redis URL for logging (remove password)
 */
function sanitizeRedisUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    if (urlObj.password) {
      urlObj.password = '***';
      return urlObj.toString();
    }
    return url;
  } catch {
    return url;
  }
}

export class RedisQueueBackend {
  private client: RedisClientType | null = null;
  private readonly keyPrefix: string;
  private readonly queueKey: string;
  private readonly dlqKey: string;
  private readonly processingStreamKey: string;
  private connected = false;

  constructor(private config: QueueConfig) {
    this.keyPrefix = config.redis.keyPrefix || DEFAULT_KEY_PREFIX;
    this.queueKey = `${this.keyPrefix}:${DEFAULT_QUEUE_KEY}`;
    this.dlqKey = `${this.keyPrefix}:${DEFAULT_DLQ_KEY}`;
    this.processingStreamKey = `${this.keyPrefix}:${DEFAULT_PROCESSING_STREAM}`;
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    const sanitizedUrl = sanitizeRedisUrl(this.config.redis.url);
    console.log(`[RedisQueue] Connecting to Redis: ${sanitizedUrl}`);

    const client = createClient({
      url: this.config.redis.url,
      password: this.config.redis.password,
    });

    client.on('error', (err) => {
      console.error('[RedisQueue] Error:', err);
    });

    await client.connect();
    this.client = client;
    this.connected = true;
    console.log('[RedisQueue] Connected');
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
      console.log('[RedisQueue] Disconnected from Redis');
    }
  }

  /**
   * Check if connected to Redis
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Enqueue a message with priority
   */
  async enqueue(msg: QueuedMessage): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('Redis client not connected');
    }

    const score = calculatePriorityScore(msg.priority, msg.timestamp);
    const messageKey = `${this.keyPrefix}:message:${msg.id}`;

    const multi = this.client.multi();

    // Store message data
    multi.hSet(messageKey, {
      id: msg.id,
      channel: msg.channel,
      sessionKey: msg.sessionKey,
      userId: msg.userId,
      text: msg.text || '',
      media: JSON.stringify(msg.media || []),
      timestamp: String(msg.timestamp),
      priority: String(msg.priority),
      metadata: JSON.stringify(msg.metadata),
      retryCount: String(msg.retryCount),
    });

    // Set expiration (7 days)
    multi.expire(messageKey, 7 * 24 * 60 * 60);

    // Add to priority queue (sorted set)
    multi.zAdd(this.queueKey, {
      score: parseFloat(score),
      value: msg.id,
    });

    await multi.exec();
  }

  /**
   * Dequeue the highest priority message (atomic using Lua script)
   */
  async dequeue(): Promise<QueuedMessage | null> {
    if (!this.client || !this.connected) {
      throw new Error('Redis client not connected');
    }

    const timestamp = String(Date.now());

    // Execute atomic Lua script
    const result = await this.client.eval(
      ATOMIC_DEQUEUE_SCRIPT,
      {
        keys: [this.queueKey, this.processingStreamKey, `${this.keyPrefix}:message:`],
        arguments: [timestamp],
      }
    );

    if (!result) {
      return null;
    }

    // Parse result: [messageId, score, ...messageData]
    const [messageId, score, ...messageData] = result as any[];

    // Build message data object from flat array
    const dataMap: Record<string, string> = {};
    for (let i = 0; i < messageData.length; i += 2) {
      if (i + 1 < messageData.length) {
        dataMap[messageData[i]] = messageData[i + 1];
      }
    }

    if (Object.keys(dataMap).length === 0) {
      // Orphaned queue entry
      return null;
    }

    return this.parseMessageData(messageId, dataMap);
  }

  /**
   * Get queue depth (number of pending messages)
   */
  async getQueueDepth(): Promise<number> {
    if (!this.client || !this.connected) {
      return 0;
    }
    return this.client.zCard(this.queueKey);
  }

  /**
   * Get message by ID (for retries/debugging)
   */
  async getMessage(messageId: string): Promise<QueuedMessage | null> {
    if (!this.client || !this.connected) {
      return null;
    }

    const messageData = await this.client.hGetAll(`${this.keyPrefix}:message:${messageId}`);
    if (!messageData || Object.keys(messageData).length === 0) {
      return null;
    }

    return this.parseMessageData(messageId, messageData);
  }

  /**
   * Remove a message (after processing or on expiry)
   */
  async removeMessage(messageId: string): Promise<void> {
    if (!this.client || !this.connected) {
      return;
    }

    await this.client.del(`${this.keyPrefix}:message:${messageId}`);
  }

  /**
   * Add message to dead letter queue (failed after max retries)
   */
  async addToDLQ(msg: QueuedMessage, error: string): Promise<void> {
    if (!this.client || !this.connected) {
      return;
    }

    const dlqEntry: DeadLetterEntry = {
      ...msg,
      error,
      failedAt: Date.now(),
    };

    const dlqKey = `${this.keyPrefix}:dlq:${msg.id}`;

    await this.client.hSet(dlqKey, {
      ...dlqEntry,
      media: JSON.stringify(dlqEntry.media || []),
      metadata: JSON.stringify(dlqEntry.metadata),
    });

    // Add to DLQ sorted set (by failure time)
    await this.client.zAdd(this.dlqKey, {
      score: Date.now(),
      value: msg.id,
    });

    // Set expiration (30 days)
    await this.client.expire(dlqKey, 30 * 24 * 60 * 60);
  }

  /**
   * Get dead letter queue entries
   */
  async getDLQEntries(limit = 100): Promise<DeadLetterEntry[]> {
    if (!this.client || !this.connected) {
      return [];
    }

    const result = await this.client.zRangeWithScores(this.dlqKey, 0, limit - 1);
    const entries: DeadLetterEntry[] = [];

    for (const { value: messageId } of result) {
      const data = await this.client.hGetAll(`${this.keyPrefix}:dlq:${messageId}`);
      if (data && Object.keys(data).length > 0) {
        entries.push({
          ...this.parseMessageData(messageId, data),
          error: data.error || '',
          failedAt: parseInt(data.failedAt || '0', 10),
        });
      }
    }

    return entries;
  }

  /**
   * Retry a message from DLQ
   */
  async retryFromDLQ(messageId: string): Promise<void> {
    if (!this.client || !this.connected) {
      return;
    }

    const dlqData = await this.client.hGetAll(`${this.keyPrefix}:dlq:${messageId}`);
    if (!dlqData || Object.keys(dlqData).length === 0) {
      return;
    }

    const msg = this.parseMessageData(messageId, dlqData);

    // Reset retry count
    msg.retryCount = 0;

    // Enqueue again
    await this.enqueue(msg);

    // Remove from DLQ
    await this.client.zRem(this.dlqKey, messageId);
    await this.client.del(`${this.keyPrefix}:dlq:${messageId}`);
  }

  /**
   * Add to processing stream for monitoring
   */
  private async addToProcessingStream(
    messageId: string,
    status: 'processing' | 'completed' | 'failed'
  ): Promise<void> {
    if (!this.client || !this.connected) {
      return;
    }

    await this.client.xAdd(this.processingStreamKey, {
      '*': {
        messageId,
        status,
        timestamp: String(Date.now()),
      },
    });
  }

  /**
   * Get processing stream entries
   */
  async getProcessingEntries(count = 100): Promise<
    Array<{ messageId: string; status: string; timestamp: number }>
  > {
    if (!this.client || !this.connected) {
      return [];
    }

    const entries = await this.client.xRange(
      this.processingStreamKey,
      '-',
      '+',
      { count }
    );

    return entries.map(entry => ({
      messageId: entry.message.messageId as string,
      status: entry.message.status as string,
      timestamp: parseInt(entry.message.timestamp as string, 10),
    }));
  }

  /**
   * Clear all queue data (uses Lua script + SCAN for safety)
   */
  async clearAll(): Promise<number> {
    if (!this.client || !this.connected) {
      return 0;
    }

    // Execute Lua script to clear queue
    const result = await this.client.eval(
      CLEAR_QUEUE_SCRIPT,
      {
        keys: [this.queueKey, `${this.keyPrefix}:message:`],
        arguments: [],
      }
    );

    return (result as number) || 0;
  }

  /**
   * Parse message data from Redis hash
   */
  private parseMessageData(
    messageId: string,
    data: Record<string, string>
  ): QueuedMessage {
    return {
      id: messageId,
      channel: data.channel as any,
      sessionKey: data.sessionKey,
      userId: data.userId,
      text: data.text || undefined,
      media: data.media ? JSON.parse(data.media) : undefined,
      timestamp: parseInt(data.timestamp, 10),
      priority: parseInt(data.priority, 10),
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
      retryCount: parseInt(data.retryCount, 10),
    };
  }
}
