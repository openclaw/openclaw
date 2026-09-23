import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { withReadySessionRows, type SessionRowReadView } from "../session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  hiddenSessionNotFound,
  type PreparedSessionMutationFacts,
} from "../session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "../session-sharing-preparation.js";
import { isGatewayAdmin, resolveSessionVisibility } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { respondChatHistoryUnavailable, type ChatHistoryMethod } from "./chat-history-recovery.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Select and revalidate history metadata through its prepared row and sharing owners. */
export async function prepareChatHistorySessionRead({
  context,
  client,
  respond,
  signal,
  method,
  sessionKey,
  agentIdOverride,
  requestedSessionId,
  retainedSessionId,
}: Pick<GatewayRequestHandlerOptions, "context" | "client" | "respond" | "signal"> & {
  method: ChatHistoryMethod;
  sessionKey: string;
  agentIdOverride?: string;
  requestedSessionId?: string;
  retainedSessionId?: string;
}) {
  const rowProjection = getSessionRowProjection(context);
  if (!rowProjection) {
    respondChatHistoryUnavailable(
      method,
      respond,
      "session rows are initializing; reload the conversation",
    );
    return undefined;
  }
  const queries = (cfg: OpenClawConfig) => {
    const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentIdOverride);
    if (!requested.ok) {
      return [];
    }
    const { canonicalKey, agentId } = resolveSessionStoreIdentity({
      cfg,
      sessionKey,
      agentId: requested.agentId,
    });
    return [{ key: canonicalKey, agentId }];
  };
  const selectSession = (read: SessionRowReadView) => {
    const cfg = read.state.cfg;
    const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentIdOverride);
    if (!requested.ok) {
      respond(false, undefined, requested.error);
      return undefined;
    }
    const requestedIdentity = resolveSessionStoreIdentity({
      cfg,
      sessionKey,
      agentId: requested.agentId,
    });
    const record = read.describe({
      key: requestedIdentity.canonicalKey,
      agentId: requestedIdentity.agentId,
    });
    const identity = record
      ? { agentId: record.agentId, canonicalKey: record.key }
      : requestedIdentity;
    return {
      cfg,
      ...identity,
      record,
      entry: record?.storedEntry ?? record?.entry,
      storePath:
        record?.storeTarget.storePath ??
        resolveSessionStorePathCore(cfg.session?.store, { agentId: identity.agentId }),
      storeKeys: [identity.canonicalKey],
      store: {},
    };
  };
  const authorizeSharing = (
    current: NonNullable<ReturnType<typeof selectSession>>,
    read: SessionRowReadView,
  ) => {
    const sharing = prepareProjectedSessionPresentation(read, client).sharing;
    if (
      current.entry
        ? sharing.entryFilter?.(current.canonicalKey, current.entry) === false
        : requestedSessionId && !retainedSessionId && !isGatewayAdmin(client)
    ) {
      respond(false, undefined, hiddenSessionNotFound(current.canonicalKey));
      return undefined;
    }
    return sharing;
  };
  const selectedSession = await measureDiagnosticsTimelineSpan(
    `gateway.${method}.session_entry`,
    () =>
      withReadySessionRows(rowProjection, queries, (read) => {
        const selected = selectSession(read);
        return selected && authorizeSharing(selected, read) ? selected : undefined;
      }),
    { config: context.getRuntimeConfig(), phase: method },
  );
  signal?.throwIfAborted();
  if (!selectedSession) {
    return undefined;
  }
  let excluded:
    | {
        readCurrent(cfg: OpenClawConfig): PreparedSessionMutationFacts;
        release(): void;
      }
    | undefined;
  try {
    if (!selectedSession.entry && !isIncognitoSessionKey(sessionKey)) {
      excluded = await prepareSessionMutationFacts({
        cfg: selectedSession.cfg,
        sessionKey,
        agentId: selectedSession.agentId,
        allowMissing: true,
      });
      signal?.throwIfAborted();
    }
    const { agentId: sessionAgentId, storePath, canonicalKey } = selectedSession;
    // The response owns nested values; resident metadata must survive caller mutation.
    const entry = selectedSession.entry ? structuredClone(selectedSession.entry) : undefined;
    const readCurrentSharing = (read: SessionRowReadView) => {
      const current = selectSession(read);
      if (!current) {
        return undefined;
      }
      if (excluded) {
        let excludedEntry;
        try {
          excludedEntry = excluded.readCurrent(read.state.cfg).target?.entry;
        } catch (error) {
          if (!(error instanceof SessionMutationFactsUnavailableError)) {
            throw error;
          }
          respondChatHistoryUnavailable(method, respond, error.message);
          return undefined;
        }
        // Excluded metadata can refuse a read, never authorize transcript delivery.
        if (excludedEntry) {
          if (authorizeSharing({ ...current, entry: excludedEntry }, read)) {
            respondChatHistoryUnavailable(
              method,
              respond,
              "session changed while reading history; reload the conversation",
            );
          }
          return undefined;
        }
      }
      const currentEntry = current.entry;
      // Task history separately validates its retained transcript; its live run may advance.
      if (
        entry &&
        (!currentEntry ||
          current.agentId !== sessionAgentId ||
          current.canonicalKey !== canonicalKey ||
          current.storePath !== storePath ||
          (!retainedSessionId &&
            (!read.describe(
              { key: canonicalKey, agentId: sessionAgentId, storePath },
              selectedSession.record,
            ) ||
              currentEntry.sessionId !== entry.sessionId ||
              currentEntry.lifecycleRevision !== entry.lifecycleRevision ||
              (entry.sessionStartedAt !== undefined &&
                currentEntry.sessionStartedAt !== entry.sessionStartedAt))))
      ) {
        respondChatHistoryUnavailable(
          method,
          respond,
          "session changed while reading history; reload the conversation",
        );
        return undefined;
      }
      const sharing = authorizeSharing(current, read);
      if (!sharing) {
        return undefined;
      }
      return currentEntry
        ? {
            visibility: resolveSessionVisibility(currentEntry),
            sharingRole: sharing.roleForTarget({
              ...current,
              entry: currentEntry,
              storeKey: current.canonicalKey,
            }),
          }
        : {};
    };
    if (excluded && !(await withReadySessionRows(rowProjection, queries, readCurrentSharing))) {
      excluded.release();
      return undefined;
    }
    signal?.throwIfAborted();
    return {
      selectedSession,
      entry,
      queries,
      readCurrentSharing,
      rowProjection,
      release: () => excluded?.release(),
    };
  } catch (error) {
    excluded?.release();
    if (error instanceof SessionMutationFactsUnavailableError) {
      respondChatHistoryUnavailable(method, respond, error.message);
      return undefined;
    }
    throw error;
  }
}
