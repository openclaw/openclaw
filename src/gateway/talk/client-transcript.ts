import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { appendClientVoiceTranscript } from "../../talk/client-voice-session.js";
import { isDashboardSessionTitleCandidate } from "../dashboard-session-title.js";
import { scheduleChatDashboardSessionTitle } from "../server-methods/chat-send-background.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { formatForLog } from "../ws-log.js";

export async function appendTalkClientTranscript(
  params: Parameters<typeof appendClientVoiceTranscript>[0] & {
    config: OpenClawConfig;
    sessionTarget: { sessionKey: string; storePath: string };
  },
  context: GatewayRequestContext,
  writer?: Parameters<typeof appendClientVoiceTranscript>[1],
): Promise<void> {
  const scope = { ...params.sessionTarget, agentId: params.agentId };
  const entry =
    params.role === "user" &&
    isDashboardSessionTitleCandidate({ sessionKey: scope.sessionKey, userMessage: params.text })
      ? await readSessionEntryReadOnlyInWorker(scope).catch((error: unknown) => {
          context.logGateway.warn(`Talk session title preparation failed: ${formatForLog(error)}`);
          return undefined;
        })
      : undefined;
  await appendClientVoiceTranscript(params, writer);
  if (entry) {
    // Bind before persistence, but start inference only after the user transcript commits.
    scheduleChatDashboardSessionTitle({
      ...scope,
      admittedSessionId: entry.sessionId,
      cfg: params.config,
      context,
      request: { rawMessage: params.text, normalizedAttachments: [] },
    });
  }
}
