// Read-side chat handlers own history projection, startup metadata, and message lookup.
import {
  ErrorCodes,
  errorShape,
  validateChatHistoryParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_HISTORY_MAX_ENTRIES } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { findModelCatalogEntry } from "../../agents/model-catalog.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import {
  listSessionPendingInputReceipts,
  resolveTranscriptSessionKeyBySessionId,
} from "../../config/sessions/session-accessor.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import {
  boundInFlightRunSnapshotForChatHistory,
  resolveInFlightRunSnapshot,
} from "../chat-abort.js";
import { resolveEffectiveChatHistoryMaxChars } from "../chat-display-projection.js";
import { resolveClaudeCliBindingSessionId } from "../cli-session-history.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { resolveSessionHistoryUnavailableMessage } from "../session-history-error.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { hiddenSessionNotFound } from "../session-sharing-policy.js";
import {
  isGatewayAdmin,
  prepareSessionSharing,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { capArrayByJsonBytes } from "../session-transcript-readers.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { buildGatewaySessionRow } from "../session-utils-row.js";
import {
  getSessionDefaults,
  loadGatewaySessionEntryReadOnly,
  resolveSessionModelRef,
} from "../session-utils.js";
import { prepareSessionWorkspaceIcon } from "../workspace-icon-http.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  createChatHistoryByteCounter,
  createChatHistoryActivityProjection,
  chatHistoryActivityBytes,
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
  trimChatHistoryActivity,
} from "./chat-history-budget.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";
import {
  capChatHistoryAroundMessage,
  enrichChatHistoryCompactionMarkers,
  resolveChatHistoryNextOffset,
} from "./chat-history-page-kernel.js";
import { readChatHistoryPage } from "./chat-history-pages.js";
import {
  resolveEmbeddedAgentRunRecoverySnapshot,
  respondChatHistoryUnavailable,
  type ChatHistoryMethod,
} from "./chat-history-recovery.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import { validateChatSelectedAgent } from "./chat-origin-routing.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import { handleChatStartupRequest } from "./chat-startup-handler.js";
import { prepareChatStartupRequester } from "./chat-startup-requester.js";
import { normalizeOptionalChatText as normalizeOptionalText } from "./chat-text-normalization.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { resolveGatewayModelSelectionPolicy } from "./session-model-selection-policy.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function handleChatHistoryRequest({
  params,
  respond,
  client,
  context,
  method,
  signal,
  retainedSessionId,
}: GatewayRequestHandlerOptions & {
  method: ChatHistoryMethod;
  retainedSessionId?: string;
}) {
  if (!assertValidParams(params, validateChatHistoryParams, method, respond)) {
    return;
  }
  const {
    sessionKey,
    limit,
    offset,
    cursor,
    messageId,
    sessionId: wireSessionId,
    maxChars,
    maxBytes,
    pendingBefore,
    inputRunIds,
  } = params;
  const requestedSessionId = retainedSessionId ?? wireSessionId;
  if (offset !== undefined && messageId !== undefined) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "offset and messageId cannot be used together"),
    );
    return;
  }
  if (cursor !== undefined && (offset !== undefined || messageId !== undefined)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "cursor cannot be used with offset or messageId"),
    );
    return;
  }
  if (wireSessionId !== undefined && messageId === undefined) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "sessionId requires messageId"),
    );
    return;
  }
  const requestConfig = context.getRuntimeConfig();
  const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
  const requestedAgent = resolveRequestedSessionAgentId(requestConfig, sessionKey, agentIdOverride);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  const selectedSession = measureDiagnosticsTimelineSpanSync(
    `gateway.${method}.session_entry`,
    () =>
      loadGatewaySessionEntryReadOnly(sessionKey, {
        agentId: requestedAgent.agentId,
        // Exact reads own their nested JSON; history only projects that snapshot.
        clone: false,
        includeStoreChildEntries: true,
        projection: "list",
      }),
    {
      config: requestConfig,
      phase: method,
    },
  );
  const {
    cfg,
    agentId: sessionAgentId,
    storePath,
    entry,
    canonicalKey,
    legacyKey,
  } = selectedSession;
  const selectedAgent = validateChatSelectedAgent({
    cfg,
    requestedSessionKey: sessionKey,
    explicitAgentId: agentIdOverride,
  });
  if (!selectedAgent.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
    return;
  }
  const authorizeSharing = (current: typeof selectedSession) => {
    const sharing = prepareSessionSharing({ client, cfg: current.cfg });
    if (
      current.entry
        ? sharing.entryFilter?.(current.legacyKey ?? current.canonicalKey, current.entry) === false
        : requestedSessionId && !retainedSessionId && !isGatewayAdmin(client)
    ) {
      respond(false, undefined, hiddenSessionNotFound(canonicalKey));
      return undefined;
    }
    return sharing;
  };
  if (!authorizeSharing(selectedSession)) {
    return;
  }
  const readCurrentSharing = () => {
    const current = entry
      ? loadGatewaySessionEntryReadOnly(sessionKey, {
          agentId: sessionAgentId,
          clone: false,
          projection: "list",
        })
      : selectedSession;
    const currentEntry = current.entry;
    // Task history separately validates its retained transcript; its live run may advance.
    if (
      entry &&
      (!currentEntry ||
        current.agentId !== sessionAgentId ||
        current.canonicalKey !== canonicalKey ||
        current.legacyKey !== legacyKey ||
        current.storePath !== storePath ||
        (!retainedSessionId &&
          (currentEntry.sessionId !== entry.sessionId ||
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
    const sharing = authorizeSharing(current);
    if (!sharing) {
      return undefined;
    }
    return currentEntry
      ? {
          visibility: resolveSessionVisibility(currentEntry),
          sharingRole: sharing.roleForTarget({
            ...current,
            entry: currentEntry,
            storeKey: current.legacyKey ?? current.canonicalKey,
          }),
        }
      : {};
  };
  if (requestedSessionId) {
    const transcriptSessionKey = resolveTranscriptSessionKeyBySessionId({
      agentId: sessionAgentId,
      sessionId: requestedSessionId,
      storePath,
    });
    if (
      !transcriptSessionKey ||
      scopeLegacySessionKeyToAgent({
        sessionKey: transcriptSessionKey,
        agentId: sessionAgentId,
      }) !== scopeLegacySessionKeyToAgent({ sessionKey: canonicalKey, agentId: sessionAgentId })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessionId does not belong to sessionKey"),
      );
      return;
    }
  }
  if (method === "chat.startup") {
    void prepareSessionWorkspaceIcon({ sessionKey, agentId: sessionAgentId }).catch(
      (error: unknown) => {
        context.logGateway.debug(
          `chat.startup continuing without a workspace icon: ${formatErrorMessage(error)}`,
        );
      },
    );
  }
  const readStartupProjection = () =>
    measureDiagnosticsTimelineSpan(
      `gateway.${method}.startup_projection`,
      async () => {
        try {
          return await context.readChatStartupProjection?.({
            agentId: sessionAgentId,
            sessionKey: canonicalKey,
            sessionEntry: entry,
            ...(method === "chat.startup"
              ? { readRequesterProfileId: await prepareChatStartupRequester(client) }
              : {}),
            readPolicy: method === "chat.history" ? "ready" : "current",
          });
        } catch (error) {
          context.logGateway.debug(
            `${method} continuing without prepared startup projection: ${formatErrorMessage(error)}`,
          );
          return undefined;
        }
      },
      { config: cfg, phase: method, attributes: { agentId: sessionAgentId } },
    );
  const startupProjectionPromise = entry?.authProfileOverride?.trim()
    ? readStartupProjection()
    : undefined;
  const sessionId = requestedSessionId ?? entry?.sessionId;
  const historyEntry =
    requestedSessionId && requestedSessionId !== entry?.sessionId ? undefined : entry;
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId, {
    allowPluginNormalization: false,
  });
  const requested = typeof limit === "number" ? limit : 200;
  const max = Math.min(CHAT_HISTORY_MAX_ENTRIES, requested);
  const maxHistoryBytes = Math.min(maxBytes ?? Infinity, getMaxChatHistoryMessagesBytes());
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(maxChars);
  const pendingInputs =
    sessionId && sessionId === entry?.sessionId
      ? readChatPendingInputs(
          {
            agentId: sessionAgentId,
            sessionKey: canonicalKey,
            sessionId,
            storePath,
          },
          { before: pendingBefore, limit: max, maxChars: effectiveMaxChars },
        )
      : { items: [], total: 0 };
  // Receipts belong to the currently selected physical session, never archived history.
  const inputReceipts = inputRunIds
    ? !messageId && sessionId && sessionId === entry?.sessionId
      ? listSessionPendingInputReceipts(
          { agentId: sessionAgentId, sessionKey: canonicalKey, sessionId, storePath },
          { runIds: inputRunIds },
        )
      : []
    : undefined;
  const inputConsumptions = inputReceipts?.flatMap((receipt) =>
    receipt.state === "consumed"
      ? [{ runId: receipt.runId, consumedByEventId: receipt.consumedByEventId }]
      : [],
  );
  let historyPage: Awaited<ReturnType<typeof readChatHistoryPage>>;
  try {
    historyPage = cursor
      ? { messages: [] }
      : await measureDiagnosticsTimelineSpan(
          `gateway.${method}.history_page`,
          () =>
            readChatHistoryPage(
              {
                entry: historyEntry,
                provider: resolvedSessionModel.provider,
                sessionId,
                storePath,
                sessionAgentId,
                canonicalKey,
                max,
                maxHistoryBytes,
                effectiveMaxChars,
                offset,
                messageId,
              },
              signal,
            ),
          {
            config: cfg,
            phase: method,
            attributes: {
              limit: max,
              hasMessageId: Boolean(messageId),
              hasOffset: offset !== undefined,
            },
          },
        );
  } catch (error) {
    const unavailableMessage = resolveSessionHistoryUnavailableMessage(error);
    if (unavailableMessage === undefined) {
      throw error;
    }
    respondChatHistoryUnavailable(method, respond, unavailableMessage);
    return;
  }
  const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, historyEntry);
  // Imported snapshots have no back-scroll cursor. Preserve their complete
  // snapshot budget until the external history owner supports pagination.
  const responseHistoryBytes = historyPage.completeCliImport
    ? getMaxChatHistoryMessagesBytes()
    : maxHistoryBytes;
  // A smaller page budget must not replace otherwise readable messages. The
  // tail cap keeps one whole message; the server's single-message cap still applies.
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity);
  const replaced = replaceOversizedChatHistoryMessages({
    byteCounter,
    messages: normalized,
    maxSingleMessageBytes: Math.min(
      CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
      getMaxChatHistoryMessagesBytes(),
    ),
  });
  // Terminal imports have no older-page cursor. Anchored reads retain their
  // existing neighborhood selector instead of changing which groups surround the anchor.
  const prioritized =
    historyPage.completeCliImport && !messageId
      ? trimChatHistoryActivity({
          messages: replaced.messages,
          maxBytes: responseHistoryBytes,
          byteCounter,
        })
      : replaced.messages;
  const capped = messageId
    ? capChatHistoryAroundMessage({
        messages: prioritized,
        messageId,
        // A nonempty JSON array costs one framing byte plus each message and its separator.
        maxCost: responseHistoryBytes - 1 - byteCounter.framingBytes(prioritized),
        messageCost: (message) => byteCounter.messageBytes(message) + 1,
      })
    : capArrayByJsonBytes(
        prioritized,
        responseHistoryBytes - byteCounter.framingBytes(prioritized),
        byteCounter.messageBytes,
      ).items;
  const historyBudgetPreserved =
    replaced.replacedCount === 0 &&
    capped.length === normalized.length &&
    capped.every((message, index) => message === normalized[index]);
  const pagination = historyPage.pagination;
  const candidateNextOffset =
    pagination === undefined
      ? undefined
      : resolveChatHistoryNextOffset({
          messages: capped,
          totalMessages: pagination.totalMessages,
          offset: pagination.offset,
          rawPageMessages: pagination.rawPageMessages,
          projected: normalized,
        });
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? pagination.exhausted !== true && candidateNextOffset < pagination.totalMessages
      : undefined;
  reportOmittedChatHistory({
    originalMessages: normalized,
    finalMessages: capped,
    getNormalizedBytes: () => byteCounter.messagesBytes(normalized),
    maxHistoryBytes: responseHistoryBytes,
    logDebug: (message) => context.logGateway.debug(message),
  });
  const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
  const startupProjection = await (startupProjectionPromise ?? readStartupProjection());
  const startupMetadata = method === "chat.startup" ? startupProjection?.metadata : undefined;
  const { sessionModelCatalog, defaultModelCatalog } = startupProjection ?? {};
  const rowProjection = getSessionRowProjection(context);
  if (!rowProjection) {
    respondChatHistoryUnavailable(
      method,
      respond,
      "session rows are initializing; reload the conversation",
    );
    return;
  }
  const query = {
    key: canonicalKey,
    agentId: sessionAgentId,
    storePath: selectedSession.readSource?.path ?? storePath,
  };
  const publishDelta = await withReadySessionRows(
    rowProjection,
    () => [query],
    (read) => {
      const currentSharing = readCurrentSharing();
      if (!currentSharing) {
        return undefined;
      }
      const sessionInfo = measureDiagnosticsTimelineSpanSync(
        `gateway.${method}.session_info`,
        () =>
          prepareProjectedSessionPresentation(read, client).snapshot(query).row ??
          (entry
            ? undefined
            : buildGatewaySessionRow({
                ...selectedSession,
                key: canonicalKey,
                modelCatalog: sessionModelCatalog,
                rowContext: rowProjection.state.rowContext,
              })),
        { config: cfg, phase: method },
      );

      if (entry && !sessionInfo) {
        respondChatHistoryUnavailable(
          method,
          respond,
          "session changed while reading history; reload the conversation",
        );
        return undefined;
      }
      if (sessionInfo) {
        Object.assign(sessionInfo, currentSharing);
      }
      const activeRunAgentId = sessionAgentId;
      const activeRunState = resolveVisibleActiveSessionRunState({
        context,
        requestedKey: sessionKey,
        canonicalKey,
        sessionId,
        ...(activeRunAgentId ? { agentId: activeRunAgentId } : {}),
        defaultAgentId: compatibilityOwnerAgentId,
        // History stays active until the terminal row is queryable or its write fails.
        includeTerminalPersistence: true,
      });
      if (sessionInfo) {
        sessionInfo.hasActiveRun = activeRunState.active;
      }
      if (sessionInfo && activeRunState.runIds !== undefined) {
        sessionInfo.activeRunIds = activeRunState.runIds;
      }
      if (sessionInfo && activeRunState.active) {
        sessionInfo.status = activeRunState.status ?? "running";
      }
      // An active embedded run can be owned by the embedded registry while absent
      // from the visible chat-abort controllers. The activeRunIds field stays
      // omitted to preserve the exact-chat-send identity contract (coordination
      // gates such as suggestion send-now rely on it being a complete set); the
      // scoped inFlightRun snapshot below drives UI adoption instead.
      const embeddedRecovery = resolveEmbeddedAgentRunRecoverySnapshot({
        chatRunState: context.chatRunState,
        requestedSessionKey: sessionKey,
        canonicalSessionKey: canonicalKey,
        sessionId,
      });
      if (sessionInfo && Object.hasOwn(historyPage, "activeLeafEntryId")) {
        sessionInfo.activeLeafEntryId = historyPage.activeLeafEntryId ?? null;
      }
      // Cursor responses publish sessionInfo only; the default-model projection is unused.
      const defaults =
        cursor === undefined
          ? {
              ...getSessionDefaults(cfg, defaultModelCatalog, {
                agentId: sessionAgentId,
                allowPluginNormalization: false,
                providerPolicySource: "active",
              }),
              modelSelectionTarget: resolveGatewayModelSelectionPolicy({
                callerScopes: client?.connect?.scopes ?? [],
                cfg,
              }).target,
            }
          : undefined;
      // Unprepared catalog facts are unknown, not an Off default or a smaller profile.
      // Omission lets clients retain richer same-identity metadata; authored defaults still apply.
      for (const [projection, catalog] of [
        [sessionInfo, sessionModelCatalog],
        [defaults, defaultModelCatalog],
      ] as const) {
        if (!projection) {
          continue;
        }
        const provider = projection.modelProvider;
        const model = projection.model;
        const catalogEntry =
          catalog && provider && model
            ? findModelCatalogEntry(catalog, { provider, modelId: model })
            : undefined;
        if (typeof catalogEntry?.reasoning === "boolean" && provider && model) {
          // Chat metadata carries the selected session auth route's capabilities.
          Object.assign(
            projection,
            resolveGatewayModelThinkingProfile({
              cfg,
              agentId: sessionAgentId,
              provider,
              model,
              modelCatalog: catalog,
              agentRuntime: projection.agentRuntime?.id,
              sessionKey: projection === sessionInfo ? canonicalKey : undefined,
              providerPolicySource: "active",
            }),
          );
          projection.thinkingOptions = projection.thinkingLevels?.map(({ label }) => label);
          continue;
        }
        delete projection.thinkingLevels;
        delete projection.thinkingOptions;
        projection.thinkingDefault =
          resolveAgentConfig(cfg, sessionAgentId)?.thinkingDefault ??
          (provider && model
            ? resolveConfiguredThinkingDefault({ cfg, provider, model })
            : cfg.agents?.defaults?.thinkingDefault);
      }
      const thinkingLevel =
        sessionInfo?.thinkingLevel ?? sessionInfo?.thinkingDefault ?? defaults?.thinkingDefault;
      const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
      if (sessionInfo) {
        sessionInfo.verboseLevel = verboseLevel;
      }
      // Surface any run still streaming for this session+agent so a client that
      // switched away (and stopped receiving the run's per-agent-delivered events)
      // can restore the in-flight assistant text on switch-back.
      const inFlightRun =
        resolveInFlightRunSnapshot({
          chatAbortControllers: context.chatAbortControllers,
          chatRunState: context.chatRunState,
          requestedSessionKey: sessionKey,
          // The agent-scoped canonical key from session load: an unscoped re-resolve
          // falls back to the default agent for alias keys, misses the abort entry's
          // stored key, and drops the in-flight snapshot for non-default agents.
          canonicalSessionKey: canonicalKey,
          agentId: activeRunAgentId,
          defaultAgentId: compatibilityOwnerAgentId,
        }) ?? embeddedRecovery;
      if (cursor !== undefined) {
        return async () => {
          if (!sessionInfo || !sessionId || !storePath || resolveClaudeCliBindingSessionId(entry)) {
            respond(true, { kind: "reset" });
            return undefined;
          }
          const sessionSnapshot = buildGatewaySessionSnapshot({
            sessionRow: sessionInfo,
            agentId: sessionAgentId,
            includeSession: true,
            activeRunState,
          });
          let delta: Awaited<ReturnType<typeof readChatHistoryDelta>>;
          try {
            const scope = {
              agentId: sessionAgentId,
              sessionEntry: entry,
              sessionId,
              sessionKey: canonicalKey,
              storePath,
            };
            delta = await readChatHistoryDelta(
              {
                agentId: sessionAgentId,
                cursor,
                maxBytes: maxHistoryBytes,
                scope,
                sessionKey: canonicalKey,
                sessionSnapshot,
                incognito: entry?.incognito,
              },
              signal,
            );
          } catch (error) {
            const unavailableMessage = resolveSessionHistoryUnavailableMessage(error);
            if (unavailableMessage === undefined) {
              throw error;
            }
            respondChatHistoryUnavailable(method, respond, unavailableMessage);
            return undefined;
          }
          const publicationSharing = readCurrentSharing();
          if (!publicationSharing) {
            return undefined;
          }
          // Delta envelopes already contain budgeted session metadata from before restoration.
          if (
            publicationSharing.visibility !== currentSharing.visibility ||
            publicationSharing.sharingRole !== currentSharing.sharingRole
          ) {
            respondChatHistoryUnavailable(
              method,
              respond,
              "session changed while reading history; reload the conversation",
            );
            return undefined;
          }
          if (delta.kind === "reset") {
            respond(true, delta);
            return undefined;
          }
          sessionInfo.activeLeafEntryId = delta.activeLeafEntryId;
          const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
            snapshot: inFlightRun,
            messages: delta.messages,
            maxBytes: maxHistoryBytes - chatHistoryActivityBytes(delta.activity),
          });
          respond(true, {
            kind: "delta",
            messages: delta.messages,
            ...(delta.activity.length > 0 ? { activity: delta.activity } : {}),
            deltaCursor: delta.deltaCursor,
            pendingInputs,
            ...(inputReceipts ? { inputReceipts, inputConsumptions } : {}),
            sessionInfo,
            ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
            ...(startupMetadata ? { metadata: startupMetadata } : {}),
          });
          return undefined;
        };
      }
      const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
        snapshot: inFlightRun,
        messages: capped,
        getMessagesBytes: () => byteCounter.messagesBytes(capped),
        maxBytes: responseHistoryBytes,
      });
      const payload = {
        sessionKey,
        sessionId,
        messages: composeTranscriptDisplay(capped),
        ...(capped.some((message) => activity.has(message))
          ? { activity: capped.flatMap((message) => activity.get(message) ?? []) }
          : {}),
        pendingInputs,
        ...(inputReceipts ? { inputReceipts, inputConsumptions } : {}),
        ...(historyPage.deltaCursor ? { deltaCursor: historyPage.deltaCursor } : {}),
        ...(historyPage.responseOffset !== undefined ? { offset: historyPage.responseOffset } : {}),
        ...(hasMore ? { nextOffset: candidateNextOffset } : {}),
        ...(hasMore !== undefined ? { hasMore } : {}),
        ...(pagination !== undefined ? { totalMessages: pagination.totalMessages } : {}),
        ...(historyPage.completeCliImport && !hasMore && historyBudgetPreserved
          ? { completeSnapshot: true }
          : {}),
        defaults,
        sessionInfo,
        thinkingLevel,
        fastMode: entry?.fastMode,
        toolOverrides: entry?.toolOverrides,
        verboseLevel,
        ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
        ...(startupMetadata ? { metadata: startupMetadata } : {}),
      };
      respond(true, payload);
      return undefined;
    },
  );
  await publishDelta?.();
}

export const chatHistoryHandlers: GatewayRequestHandlers = {
  "chat.history": (opts) => handleChatHistoryRequest({ ...opts, method: "chat.history" }),
  "chat.startup": (opts) =>
    handleChatStartupRequest(opts, handleChatHistoryRequest, respondChatHistoryUnavailable),
  "chat.metadata": handleChatMetadataRequest,
};
