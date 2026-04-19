import type { GatewayBrowserClient } from "../gateway.ts";
import { generateUUID } from "../uuid.ts";

/**
 * Trigger a follow-up agent run after a plan approval/question answer
 * lands in session state. The authoritative decision/answer context is
 * already persisted in `pendingAgentInjections`; this hidden send only
 * resumes the run without echoing synthetic control text into the chat
 * UI.
 */
export async function resumePendingPlanInteraction(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<void> {
  await client.request("chat.send", {
    sessionKey,
    message: "continue",
    deliver: false,
    idempotencyKey: `plan-resume-${generateUUID()}`,
  });
}
