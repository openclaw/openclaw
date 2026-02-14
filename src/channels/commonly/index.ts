/**
 * Commonly Channel for Clawdbot
 *
 * Native integration with Commonly pods for real-time agent communication.
 * Uses WebSocket for events and REST API for context/messaging.
 *
 * Features:
 * - Real-time event push via WebSocket (no polling)
 * - Full Commonly context assembly
 * - Pod memory read/write
 * - Thread comments
 * - Ensemble discussion participation
 */

import { CommonlyClient } from './client.js';
import { CommonlyWebSocket } from './websocket.js';
import { CommonlyTools } from './tools.js';
import type {
  CommonlyInboundMessage,
  CommonlyOutboundMessage,
  CommonlyChannelContext,
  CommonlyEventPayload,
  CommonlyEvent,
} from './events.js';

export interface CommonlyChannelConfig {
  baseUrl: string;
  runtimeToken: string;
  userToken?: string;
  agentName?: string;
  instanceId?: string;
  podIds?: string[];
}

export class CommonlyChannel {
  readonly name = 'commonly';
  readonly displayName = 'Commonly';

  private config: CommonlyChannelConfig;
  private client: CommonlyClient;
  private ws: CommonlyWebSocket;
  private tools: CommonlyTools;
  private connected = false;

  constructor(config: CommonlyChannelConfig) {
    this.config = {
      agentName: 'openclaw',
      instanceId: 'default',
      podIds: [],
      ...config,
    };

    this.client = new CommonlyClient(this.config);
    this.ws = new CommonlyWebSocket(this.config);
    this.tools = new CommonlyTools(this.client);
  }

  /**
   * Initialize the channel
   */
  async init(): Promise<void> {
    console.log(`[commonly] Initializing channel for ${this.config.agentName}`);

    // Test API connection
    const healthy = await this.client.healthCheck();
    if (!healthy) {
      throw new Error('Failed to connect to Commonly API');
    }

    // Connect WebSocket
    await this.ws.connect();

    // Subscribe to configured pods
    if (this.config.podIds && this.config.podIds.length > 0) {
      this.ws.subscribe(this.config.podIds);
    }

    this.connected = true;
    console.log(`[commonly] Channel initialized`);
  }

  /**
   * Register event handler
   */
  onEvent(handler: (event: CommonlyInboundMessage) => Promise<void>): void {
    this.ws.onEvent(async (event: CommonlyEvent) => {
      const message = this.transformEvent(event);
      if (message) {
        await handler(message);
      }
    });
  }

  /**
   * Send a message to a pod
   */
  async send(message: CommonlyOutboundMessage): Promise<void> {
    const { targetId, content, metadata } = message;

    const threadId = typeof metadata?.threadId === 'string' ? metadata.threadId.trim() : '';
    if (threadId) {
      await this.client.postThreadComment(threadId, content);
    } else {
      await this.client.postMessage(targetId, content, metadata);
    }
  }

  /**
   * Get context for a pod
   */
  async getContext(podId: string, task?: string): Promise<CommonlyChannelContext> {
    const context = await this.client.getContext(podId, task);
    return {
      podId,
      podName: context?.pod?.name,
      memory: context?.memory,
      skills: context?.skills,
      summaries: context?.summaries,
      assets: context?.assets,
    };
  }

  /**
   * Get available tools for this channel
   */
  getTools() {
    return this.tools.getToolDefinitions();
  }

  /**
   * Execute a tool
   */
  async executeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.tools.execute(toolName, args);
  }

  /**
   * Disconnect the channel
   */
  async disconnect(): Promise<void> {
    this.ws.disconnect();
    this.connected = false;
    console.log(`[commonly] Channel disconnected`);
  }

  /**
   * Transform Commonly event to InboundMessage format
   */
  private transformEvent(event: {
    type: string;
    podId: string;
    payload: CommonlyEventPayload;
    _id: string;
  }): CommonlyInboundMessage | null {
    const { type, podId, payload, _id } = event;

    const base = {
      id: _id,
      channelId: podId,
      channelName: 'commonly',
      senderId: payload.userId || 'unknown',
      senderName: payload.username || 'Unknown',
      timestamp: new Date(),
    };

    switch (type) {
      case 'chat.mention':
        return {
          ...base,
          type: 'message',
          content: payload.content ?? '',
          metadata: {
            mentions: payload.mentions,
            messageId: payload.messageId,
          },
        };
      case 'thread.mention':
        return {
          ...base,
          type: 'thread_mention',
          content: payload.content ?? '',
          metadata: {
            thread: payload.thread,
            messageId: payload.messageId,
          },
        };

      case 'ensemble.turn':
        return {
          ...base,
          type: 'ensemble_turn',
          content: payload.context?.topic || '',
          metadata: {
            ensembleId: payload.ensembleId,
            context: payload.context,
          },
        };
      case 'heartbeat':
        return {
          ...base,
          type: 'message',
          content: payload.content
            || 'System heartbeat from Commonly scheduler. Check pod context and act only if useful.',
          metadata: {
            trigger: payload.trigger,
            generatedAt: payload.generatedAt,
            availableIntegrations: payload.availableIntegrations,
          },
        };
      case 'summary.request':
        return {
          ...base,
          type: 'summary',
          content: payload.content
            || 'Summary requested by Commonly scheduler. Summarize recent pod activity.',
          metadata: {
            source: payload.source,
            trigger: payload.trigger,
            windowMinutes: payload.windowMinutes,
            includeDigest: payload.includeDigest,
          },
        };

      default:
        console.log(`[commonly] Unknown event type: ${type}`);
        return null;
    }
  }

  /**
   * Check if channel is connected
   */
  isConnected(): boolean {
    return this.connected && this.ws.isConnected();
  }
}

export { CommonlyClient } from './client.js';
export { CommonlyWebSocket } from './websocket.js';
export { CommonlyTools } from './tools.js';
export type { CommonlyInboundMessage, CommonlyOutboundMessage, CommonlyChannelContext };
