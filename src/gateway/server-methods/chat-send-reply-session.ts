import type { PreparedReplyTranscriptStart } from "../../auto-reply/get-reply-options.types.js";
import type { ReplySessionBinding } from "../../auto-reply/reply/get-reply.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { resolveChatReplyTranscriptStart } from "./chat-send-reply-delivery.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";

export type ChatReplySession = Pick<
  PreparedChatSendSession,
  "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
> &
  Partial<Pick<PreparedChatSendSession, "entry" | "storePath">>;

/** Initialization owns the start binding; later delivery decisions read fresh stored rows. */
export function createChatReplySessionReader(session: ChatReplySession) {
  const initialStorePath =
    session.storePath ??
    resolveSessionStorePathCore(session.cfg.session?.store, { agentId: session.agentId });
  let preparedSession: Omit<ReplySessionBinding, "sessionId"> & { sessionId?: string } = {
    sessionKey: session.sessionKey,
    sessionId: session.entry?.sessionId ?? session.backingSessionId,
    lifecycleRevision: session.entry?.lifecycleRevision,
    storePath: initialStorePath,
  };
  return {
    notePreparedSession(this: void, binding: ReplySessionBinding) {
      if (binding.sessionKey === session.sessionKey) {
        preparedSession = { ...binding };
      }
    },
    captureTranscriptStart(this: void, prepared?: PreparedReplyTranscriptStart | null) {
      const start = resolveChatReplyTranscriptStart(
        session,
        { entry: preparedSession, storePath: preparedSession.storePath ?? initialStorePath },
        prepared,
      );
      return start ? { ...start, lifecycleRevision: preparedSession.lifecycleRevision } : undefined;
    },
    async readCurrentSession(this: void, key = session.sessionKey, agentId = session.agentId) {
      const cfg = getRuntimeConfig();
      const assertRoutingCurrent = captureSessionMutationRouting(cfg);
      return await loadGatewaySessionEntryReadOnlyInWorker({
        ...session.sessionLoadOptions,
        cfg,
        key,
        excludeInternalEffects: true,
        agentId,
        assertActive: () => assertRoutingCurrent(getRuntimeConfig()),
      });
    },
  };
}
