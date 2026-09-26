import {
  mergeChatStreamMessage,
  type EventFrame,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";

type RequestClient = {
  request<T>(method: string, params?: unknown, options?: GatewayProtocolRequestOptions): Promise<T>;
};

/** One browser connection reconstructs wire text before its local listeners share it. */
export class GatewayChatEvents {
  private readonly messages = new Map<
    string,
    { sessionKey: string; agentId: unknown; message: unknown }
  >();
  private readonly projectedEvents = new WeakMap<EventFrame, EventFrame | null>();
  private generation = 0;

  constructor(private readonly reconnect: (reason: string) => void) {}

  clear(): void {
    this.generation += 1;
    this.messages.clear();
  }

  async request<T>(
    client: RequestClient,
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    const generation = this.generation;
    const result = await client.request<T>(method, params, options);
    if (method === "sessions.messages.unsubscribe" && generation === this.generation) {
      const key = asNullableRecord(result)?.key;
      const request = asNullableRecord(params);
      const agentId =
        (typeof key === "string" ? parseAgentSessionKeyParts(key)?.agentId : undefined) ??
        request?.agentId ??
        (key === "global" && typeof request?.key === "string"
          ? parseAgentSessionKeyParts(request.key)?.agentId
          : undefined);
      for (const [runId, stream] of this.messages) {
        const streamAgentId =
          stream.agentId ?? parseAgentSessionKeyParts(stream.sessionKey)?.agentId;
        if (stream.sessionKey === key && streamAgentId === agentId) {
          this.messages.delete(runId);
        }
      }
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
    if (event.event !== "chat") {
      return event;
    }
    if (this.projectedEvents.has(event)) {
      return this.projectedEvents.get(event) ?? null;
    }
    const payload = asNullableRecord(event.payload);
    if (!payload || typeof payload.runId !== "string" || typeof payload.sessionKey !== "string") {
      return event;
    }
    let projected: EventFrame | null = event;
    if (payload.state === "delta") {
      const previous = this.messages.get(payload.runId);
      const message = mergeChatStreamMessage(
        previous?.sessionKey === payload.sessionKey && previous.agentId === payload.agentId
          ? previous.message
          : undefined,
        payload,
      );
      if (message === undefined) {
        projected = null;
        this.reconnect("chat stream baseline missing");
      } else {
        this.messages.set(payload.runId, {
          sessionKey: payload.sessionKey,
          agentId: payload.agentId,
          message,
        });
        projected = { ...event, payload: { ...payload, message } };
      }
    } else if (
      payload.state === "final" ||
      payload.state === "error" ||
      payload.state === "aborted"
    ) {
      this.messages.delete(payload.runId);
    }
    // The protocol owns listener dispatch; each listener sees the same reconstruction.
    this.projectedEvents.set(event, projected);
    return projected;
  }
}
