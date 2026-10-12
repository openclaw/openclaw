import { isDeepStrictEqual } from "node:util";
import type { PreparedReplyTranscriptStart } from "../../auto-reply/get-reply-options.types.js";
import type { ReplySessionBinding } from "../../auto-reply/reply/get-reply.types.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { withQualifiedGatewaySessionStoreTarget } from "../session-utils-store-retained.js";
import {
  findCanonicalStoreMatch,
  omitInternalSessionEffectsEntries,
} from "../session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import {
  resolveChatReplyTranscriptStart,
  resolveLegacyChatReplyTranscriptStart,
} from "./chat-send-reply-delivery.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";

export type ChatReplySession = Pick<
  PreparedChatSendSession,
  "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
> &
  Partial<
    Pick<
      PreparedChatSendSession,
      "entry" | "storePath" | "sessionTarget" | "capturedReadSources" | "assertSessionTargetCurrent"
    >
  >;

/** Initialization owns the start binding; later delivery decisions read fresh stored rows. */
export function createChatReplySessionReader(
  session: ChatReplySession,
  getRuntimeConfig: () => OpenClawConfig,
  assertWorkCurrent?: () => void,
) {
  const initialStorePath =
    session.storePath ??
    resolveSessionStorePathCore(session.cfg.session?.store, { agentId: session.agentId });
  let preparedSession: Omit<ReplySessionBinding, "sessionId"> & { sessionId?: string } = {
    sessionKey: session.sessionKey,
    sessionId: session.entry?.sessionId ?? session.backingSessionId,
    lifecycleRevision: session.entry?.lifecycleRevision,
    storePath: initialStorePath,
  };
  const target = session.sessionTarget;
  const source = target?.readSource;
  const assertTargetCurrent = session.assertSessionTargetCurrent;
  // Other sources or spellings would make qualification's absence checks query SQLite.
  const borrowed =
    target &&
    source &&
    typeof source.databaseIdentity === "string" &&
    assertWorkCurrent &&
    assertTargetCurrent &&
    target.storeKeys.length === 1 &&
    target.storeKeys[0] === target.storeKey &&
    session.capturedReadSources?.length === 1 &&
    isDeepStrictEqual(session.capturedReadSources[0], source)
      ? {
          target,
          source: { ...source, databaseIdentity: source.databaseIdentity },
          assertTargetCurrent,
          assertWorkCurrent,
        }
      : undefined;
  const assertBorrowedRouting = captureSessionMutationRouting(session.cfg, undefined, [session]);
  const assertRetainedSourceCurrent = borrowed
    ? () => {
        borrowed.assertWorkCurrent();
        borrowed.assertTargetCurrent();
        assertBorrowedRouting(getRuntimeConfig());
      }
    : undefined;
  return {
    assertRetainedSourceCurrent,
    notePreparedSession(this: void, binding: ReplySessionBinding) {
      if (binding.sessionKey === session.sessionKey) {
        preparedSession = { ...binding };
      }
    },
    captureTranscriptStart(this: void, prepared?: PreparedReplyTranscriptStart | null) {
      const current = {
        entry: preparedSession,
        storePath: preparedSession.storePath ?? initialStorePath,
      };
      const start =
        prepared === undefined
          ? resolveLegacyChatReplyTranscriptStart(session, current)
          : resolveChatReplyTranscriptStart(session, current, prepared);
      return start ? { ...start, lifecycleRevision: preparedSession.lifecycleRevision } : undefined;
    },
    async readCurrentSession(this: void, key = session.sessionKey, agentId = session.agentId) {
      const cfg = getRuntimeConfig();
      if (
        borrowed &&
        assertRetainedSourceCurrent &&
        key === session.sessionKey &&
        agentId === session.agentId
      ) {
        const assertCurrent = assertRetainedSourceCurrent;
        assertCurrent();
        return withQualifiedGatewaySessionStoreTarget({
          target: borrowed.target,
          logicalStorePath: initialStorePath,
          preparedSource: { ...borrowed.source, assertCurrent },
          includeMembership: false,
          readOptions: { projection: "exact", lifecycleSessionKey: undefined },
          consume: (selected, _membership, assertSourceCurrent) => {
            assertSourceCurrent();
            assertCurrent();
            omitInternalSessionEffectsEntries(selected.store, selected.storeKeys);
            const match = findCanonicalStoreMatch(selected.store, selected.storeKeys);
            return {
              ...selected,
              cfg,
              entry: match?.entry,
              legacyKey: match?.key !== selected.canonicalKey ? match?.key : undefined,
            };
          },
        });
      }
      const assertRoutingCurrent = captureSessionMutationRouting(cfg, undefined, [
        { sessionKey: key, agentId },
      ]);
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
