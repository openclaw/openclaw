import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayEventFrame } from "../api/gateway.ts";

export function isCanvasWidgetLoadRetryEvent(
  event: GatewayEventFrame,
  binding: { operatorRead: boolean; sessionKey: string },
): boolean {
  const payload = asOptionalRecord(event.payload);
  if (binding.operatorRead || payload?.sessionKey !== binding.sessionKey) {
    return false;
  }
  const message = asOptionalRecord(payload.message);
  return (
    (event.event === "session.message" &&
      message?.role === "toolResult" &&
      message.toolName === "show_widget") ||
    (event.event === "chat" &&
      (payload.state === "final" || payload.state === "aborted" || payload.state === "error"))
  );
}
