import type {
  SessionObserverDigest,
  SessionsObserverAskResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";

export function resolveChatPaneObserverRunId(params: {
  localRunId: string | null;
  session: Pick<GatewaySessionRow, "hasActiveRun" | "activeRunIds"> | undefined;
  digest: SessionObserverDigest | null;
}): string | null {
  if (params.localRunId) {
    return params.localRunId;
  }
  if (!params.session?.hasActiveRun) {
    return null;
  }
  const activeRunIds = params.session.activeRunIds ?? [];
  return params.digest?.runId && activeRunIds.includes(params.digest.runId)
    ? params.digest.runId
    : (activeRunIds[0] ?? null);
}

export function requestSessionObserverAnswer(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
  question: string,
): Promise<SessionsObserverAskResult> {
  return client.request<SessionsObserverAskResult>("sessions.observer.ask", {
    sessionKey,
    question,
  });
}
