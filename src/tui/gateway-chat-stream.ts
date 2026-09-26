import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { mergeChatStreamMessage } from "../../packages/gateway-client/src/chat-stream-message.js";
import type { TuiEvent } from "./tui-backend.js";

/** Wire baselines belong to the connection, including sessions outside the selected viewport. */
export class GatewayChatStream {
  private readonly runs = new Map<
    string,
    { sessionKey: string; agentId: unknown; message: unknown }
  >();

  project(event: TuiEvent): TuiEvent {
    if (event.event !== "chat") {
      return event;
    }
    const payload = asNullableRecord(event.payload);
    if (!payload || typeof payload.runId !== "string" || typeof payload.sessionKey !== "string") {
      return event;
    }
    if (payload.state === "delta") {
      const previous = this.runs.get(payload.runId);
      const message = mergeChatStreamMessage(
        previous?.sessionKey === payload.sessionKey && previous.agentId === payload.agentId
          ? previous.message
          : undefined,
        payload,
      );
      if (message !== undefined) {
        this.runs.set(payload.runId, {
          sessionKey: payload.sessionKey,
          agentId: payload.agentId,
          message,
        });
      }
      return { ...event, payload: { ...payload, message } };
    }
    if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
      this.runs.delete(payload.runId);
    }
    return event;
  }

  clear(): void {
    this.runs.clear();
  }
}
