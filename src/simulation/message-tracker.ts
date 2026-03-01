import type { SimInboundMessage, SimMessage, SimOutboundMessage } from "./types.js";

/**
 * Ordered message log with O(1) lookups by ID and conversation.
 * Maintains a monotonic sequence counter for same-ms tiebreaking.
 */
export class MessageTracker {
  private log: SimMessage[] = [];
  private byId = new Map<string, SimMessage>();
  private byConversation = new Map<string, SimMessage[]>();
  private nextSeq = 0;

  /** Record a message, assign a seq number, and update indexes. */
  record(msg: Omit<SimMessage, "seq">): SimMessage {
    const withSeq = { ...msg, seq: this.nextSeq++ } as SimMessage;
    this.log.push(withSeq);
    this.byId.set(withSeq.id, withSeq);

    let convList = this.byConversation.get(withSeq.conversationId);
    if (!convList) {
      convList = [];
      this.byConversation.set(withSeq.conversationId, convList);
    }
    convList.push(withSeq);

    return withSeq;
  }

  /** All messages in insertion order. */
  messages(): readonly SimMessage[] {
    return this.log;
  }

  /** Messages for a specific conversation. */
  conversation(id: string): readonly SimMessage[] {
    return this.byConversation.get(id) ?? [];
  }

  /** Get a single message by ID. */
  get(id: string): SimMessage | undefined {
    return this.byId.get(id);
  }

  /** Build the causal chain for a message (walk causalParentId links). */
  causalChain(messageId: string): SimMessage[] {
    const chain: SimMessage[] = [];
    let current = this.byId.get(messageId);
    while (current) {
      chain.push(current);
      if (current.direction === "outbound" && current.causalParentId) {
        current = this.byId.get(current.causalParentId);
      } else {
        break;
      }
    }
    return chain;
  }

  /** Find outbound messages where the agent missed recent messages (stale context). */
  staleContextMessages(): SimOutboundMessage[] {
    const stale: SimOutboundMessage[] = [];
    for (const msg of this.log) {
      if (msg.direction !== "outbound") {
        continue;
      }
      if (!msg.causalParentId) {
        continue;
      }
      const parent = this.byId.get(msg.causalParentId);
      if (!parent) {
        continue;
      }
      const convMsgs = this.byConversation.get(msg.conversationId) ?? [];
      // Find how many inbound messages arrived between the causal parent and this reply
      let missed = 0;
      for (const convMsg of convMsgs) {
        if (convMsg.direction !== "inbound") {
          continue;
        }
        if (convMsg.ts > parent.ts && convMsg.ts < msg.ts) {
          missed++;
        }
      }
      if (missed > 0) {
        stale.push(msg);
      }
    }
    return stale;
  }

  /** Inbound messages per conversation per time window. */
  throughput(windowMs: number): Map<string, number[]> {
    const result = new Map<string, number[]>();
    if (this.log.length === 0) {
      return result;
    }

    const firstTs = this.log[0].ts;
    for (const [convId, msgs] of this.byConversation) {
      const inbound = msgs.filter((m): m is SimInboundMessage => m.direction === "inbound");
      if (inbound.length === 0) {
        continue;
      }
      const lastTs = inbound[inbound.length - 1].ts;
      const bucketCount = Math.ceil((lastTs - firstTs + 1) / windowMs);
      const buckets: number[] = Array.from({ length: bucketCount }, () => 0);
      for (const msg of inbound) {
        const idx = Math.floor((msg.ts - firstTs) / windowMs);
        buckets[idx]++;
      }
      result.set(convId, buckets);
    }
    return result;
  }

  /** Total message count. */
  get size(): number {
    return this.log.length;
  }
}
