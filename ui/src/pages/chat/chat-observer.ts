import type { SessionsObserverVisibilityResult } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { loadChatObserverDisplayPreference } from "./chat-observer-display.ts";

export async function sendSessionObserverVisibility(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase">,
  visible?: boolean,
): Promise<SessionsObserverVisibilityResult | undefined> {
  if (!canCallGatewayMethod(snapshot, "sessions.observer.visibility", "operator.read")) {
    return undefined;
  }
  return snapshot.client!.request<SessionsObserverVisibilityResult>(
    "sessions.observer.visibility",
    {
      visible: visible ?? loadChatObserverDisplayPreference() !== "off",
    },
  );
}
