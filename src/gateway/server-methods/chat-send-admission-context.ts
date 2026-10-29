import { isDeepStrictEqual } from "node:util";
import {
  captureAcpSessionEntryBinding,
  type AcpSessionEntryExpectation,
} from "../../acp/runtime/session-meta-entry.kernel.js";
import { readAcpSessionMetaForEntries } from "../../acp/runtime/session-meta-readonly.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveChatSendOriginatingRoute } from "./chat-origin-routing.js";
import { respondChatSendAdmissionError } from "./chat-send-admission-errors.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function prepareChatSendAdmissionContext(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  client: GatewayRequestHandlerOptions["client"];
}) {
  const { request, session, client } = params;
  const { p, explicitOrigin, normalizedAttachments } = request;
  const { cfg, entry, sessionKey, selectedAgent, agentId, clientRunId, resolvedSessionModel } =
    session;
  return {
    chatSendTraceAttributes: {
      runId: clientRunId,
      sessionKey,
      agentId: selectedAgent.agentId ?? agentId,
      provider: resolvedSessionModel.provider,
      model: resolvedSessionModel.model,
      hasAttachments: normalizedAttachments.length > 0,
      hasExplicitOrigin: explicitOrigin !== undefined,
      hasConnectedClient: client?.connect !== undefined,
    },
    originatingRoute: resolveChatSendOriginatingRoute({
      client: request.clientInfo,
      deliver: p.deliver,
      entry,
      explicitOrigin,
      hasConnectedClient: client?.connect !== undefined,
      mainKey: cfg.session?.mainKey,
      sessionKey,
    }),
  };
}

/** Reuse request preparation; final ordered admission checks this lifecycle binding. */
export async function prepareChatSendAcpMetadata(
  { session, diagnostics }: ChatSendAdmissionParams,
  currentSelection?: { binding: AcpSessionEntryExpectation; canonicalKey: string },
) {
  const selected = currentSelection ?? {
    canonicalKey: session.sessionTarget.canonicalKey,
    binding: session.entry ? captureAcpSessionEntryBinding(session.entry) : null,
  };
  using _ = diagnostics?.scope("detail.admission.acp_metadata");
  const [meta] = await readAcpSessionMetaForEntries({
    cfg: session.cfg,
    entries: [
      {
        agentId: session.agentId,
        sessionKey: selected.canonicalKey,
        entry: selected.binding ?? undefined,
      },
    ],
  });
  return { binding: selected.binding, meta: meta ?? null };
}

export function prepareChatSendAcpRefresh(
  params: ChatSendAdmissionParams,
  prepared: Awaited<ReturnType<typeof prepareChatSendAcpMetadata>> | null,
  latest: { entry?: SessionEntry; canonicalKey: string },
) {
  if (!prepared) {
    return undefined;
  }
  const binding = latest.entry ? captureAcpSessionEntryBinding(latest.entry) : null;
  // The request snapshot may precede a queued same-ID lifecycle change.
  return isDeepStrictEqual(prepared.binding, binding)
    ? undefined
    : () => prepareChatSendAcpMetadata(params, { binding, canonicalKey: latest.canonicalKey });
}

/** Check the captured target assertion and settle admission failure before responding. */
export function assertChatSendSessionTargetOrRespond(params: {
  assertSessionTargetCurrent: () => void;
  cleanup: () => void;
  respond: GatewayRequestHandlerOptions["respond"];
}): boolean {
  try {
    params.assertSessionTargetCurrent();
    return true;
  } catch (error) {
    params.cleanup();
    respondChatSendAdmissionError(error, params.respond);
    return false;
  }
}
