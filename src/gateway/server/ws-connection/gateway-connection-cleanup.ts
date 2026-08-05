import { disposeSystemAgentSessionsForOwner } from "../../server-methods/system-agent-session-disposal.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { formatError } from "../../server-utils.js";
import { closeTalkRealtimeRelaySessionsForConnection } from "../../talk-realtime-relay.js";
import { closeTalkTranscriptionRelaySessionsForConnection } from "../../talk-transcription-relay.js";

export function cleanupGatewayConnectionResources(params: {
  context: GatewayRequestContext;
  connId: string;
  warn: (message: string) => void;
}): void {
  void disposeSystemAgentSessionsForOwner(
    params.context.systemAgentSessions,
    `connection:${params.connId}`,
  ).catch((error: unknown) => {
    params.warn(
      `failed to dispose connection-owned system-agent sessions conn=${params.connId}: ${formatError(error)}`,
    );
  });
  closeTalkRealtimeRelaySessionsForConnection(params.connId);
  closeTalkTranscriptionRelaySessionsForConnection(params.connId);
  params.context.unsubscribeAllSessionEvents(params.connId);
  // PTYs detach or stop according to their grace policy. Keep every connection
  // owner here so another close path cannot strand one of these resources.
  params.context.terminalSessions?.handleDisconnect(params.connId);
}
