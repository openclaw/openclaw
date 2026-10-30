import {
  GatewayChatStreamProjection,
  type EventFrame,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { GatewaySessionRowEvents } from "./gateway-session-row-events.ts";

type RequestClient = {
  request<T>(method: string, params?: unknown, options?: GatewayProtocolRequestOptions): Promise<T>;
};

/** One browser connection reconstructs wire deltas before its local listeners share them. */
export class GatewayChatEvents {
  private readonly stream = new GatewayChatStreamProjection();
  private readonly rows = new GatewaySessionRowEvents();
  private readonly projectedEvents = new WeakMap<EventFrame, EventFrame | null>();

  constructor(private readonly reconnect: (reason: string) => void) {}

  clear(): void {
    this.stream.clear();
    this.rows.clear();
  }

  async request<T>(
    client: RequestClient,
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    const result = await client.request<T>(method, params, options);
    // Late ACKs can retire chat text baselines; session-row baselines belong to the socket.
    if (method === "sessions.messages.unsubscribe") {
      const key = asNullableRecord(result)?.key;
      const request = asNullableRecord(params);
      const agentId =
        (typeof key === "string" ? parseAgentSessionKeyParts(key)?.agentId : undefined) ??
        request?.agentId ??
        (key === "global" && typeof request?.key === "string"
          ? parseAgentSessionKeyParts(request.key)?.agentId
          : undefined);
      this.stream.retire((stream) => {
        const streamAgentId =
          stream.agentId ?? parseAgentSessionKeyParts(stream.sessionKey)?.agentId;
        return stream.sessionKey === key && streamAgentId === agentId;
      });
    }
    return result;
  }

  dispatch(event: EventFrame, listener?: (event: EventFrame) => void): void {
    const projected = this.project(event);
    if (projected) {
      listener?.(projected);
    }
  }

  private project(event: EventFrame): EventFrame | null {
    if (
      event.event !== "chat" &&
      event.event !== "sessions.changed" &&
      event.event !== "session.message"
    ) {
      return event;
    }
    if (this.projectedEvents.has(event)) {
      return this.projectedEvents.get(event) ?? null;
    }
    const result = event.event === "chat" ? this.stream.project(event) : this.rows.project(event);
    const projected = result.missingBaseline ? null : result.event;
    if (result.missingBaseline) {
      this.reconnect(
        event.event === "chat" ? "chat stream baseline missing" : "session row baseline missing",
      );
    }
    // The protocol owns listener dispatch; each listener sees the same reconstruction.
    this.projectedEvents.set(event, projected);
    return projected;
  }
}
