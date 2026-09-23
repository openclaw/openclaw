import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

type ChatAbortRequestTarget = { sessionKey: string; agentId?: string } & (
  | { runId: string; sessionAbortable?: boolean }
  | { runId: null; clearQueued?: true }
);

export type ChatAbortRequestResult =
  | { ok: true; noActiveRun: boolean; warning?: string }
  | { ok: false; error: unknown };

export async function requestChatAbort(
  client: GatewayBrowserClient,
  intent: ChatAbortRequestTarget,
): Promise<ChatAbortRequestResult> {
  try {
    // Recovered embedded runs retain their exact identity on the session-owned route.
    const sessionAbort = intent.runId === null || intent.sessionAbortable === true;
    const response = asOptionalRecord(
      await client.request(sessionAbort ? "sessions.abort" : "chat.abort", {
        ...(sessionAbort ? { key: intent.sessionKey } : { sessionKey: intent.sessionKey }),
        ...(intent.agentId ? { agentId: intent.agentId } : {}),
        ...(intent.runId !== null
          ? { runId: intent.runId }
          : intent.clearQueued
            ? { clearQueued: true }
            : {}),
      }),
    );
    return {
      ok: true,
      // Other response shapes still leave settlement to live events.
      noActiveRun: response?.aborted === false || response?.status === "no-active-run",
      warning: normalizeOptionalString(response?.warning),
    };
  } catch (err) {
    return { ok: false, error: err };
  }
}
