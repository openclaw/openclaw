import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatHistoryParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { findModelCatalogEntry } from "../../agents/model-catalog.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareOptionalSubagentSessionListReadCache,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { listSessionPendingInputReceipts } from "../../config/sessions/session-accessor.js";
import { readSessionHistoryPageInWorker } from "../../config/sessions/session-history-worker-runtime.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import { resolveInFlightRunSnapshot } from "../chat-abort.js";
import { resolveEffectiveChatHistoryMaxChars } from "../chat-display-projection.js";
import { isQueuedChatTurnForSession } from "../chat-queued-turns.js";
import { resolveClaudeCliBindingSessionId } from "../cli-session-history.js";
import { projectOperatorModelRead } from "../operator-model-presentation.js";
import { SerializedJsonArray } from "../serialized-json.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { resolveSessionHistoryUnavailableMessage } from "../session-history-error.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import { buildGatewaySessionRow } from "../session-utils-row.js";
import { getSessionDefaults, resolveSessionModelRef } from "../session-utils.js";
import { prepareSessionWorkspaceIcon } from "../workspace-icon-http.js";
import {
  boundInFlightRunSnapshotForChatHistory,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";
import { readChatHistoryPage } from "./chat-history-pages.js";
import {
  resolveEmbeddedAgentRunRecoverySnapshot,
  respondChatHistoryUnavailable,
  type ChatHistoryMethod,
} from "./chat-history-recovery.js";
import { prepareChatHistoryResponsePage } from "./chat-history-response-page.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import { handleChatStartupRequest } from "./chat-startup-handler.js";
import { prepareChatStartupRequester } from "./chat-startup-requester.js";
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
  sessionMutationAuthorization,
  retainedTranscript,
  acceptsSerializedJson,
  req,
}: GatewayRequestHandlerOptions & {
  method: ChatHistoryMethod;
  retainedTranscript?: {
    sessionId: string;
    requireCurrentSession?: boolean;
    verifyRetainedState?: () => Promise<boolean>;
  };
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
  const retainedSessionId = retainedTranscript?.sessionId;
  const requestedSessionId = retainedSessionId ?? wireSessionId;
  let selectorError: string | undefined;
  if (offset !== undefined && messageId !== undefined) {
    selectorError = "offset and messageId cannot be used together";
  } else if (cursor !== undefined && (offset !== undefined || messageId !== undefined)) {
    selectorError = "cursor cannot be used with offset or messageId";
  } else if (wireSessionId !== undefined && messageId === undefined) {
    selectorError = "sessionId requires messageId";
  }
  if (selectorError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectorError));
    return;
  }
  if (!getSubagentSessionListReadSnapshotIdentity()) {
    await prepareOptionalSubagentSessionListReadCache();
  }
  signal?.throwIfAborted();
  const agentIdOverride = normalizeOptionalString(params.agentId);
  const selection = await prepareChatHistorySessionRead({
    context,
    sessionMutationAuthorization,
    client,
    respond,
    signal,
    method,
    sessionKey,
    agentIdOverride,
    requestedSessionId,
    retainedSessionId,
  });
  if (!selection) {
    return;
  }
  try {
    const { selectedSession, entry, queries, readCurrentSharing, rowProjection } = selection;
    const { cfg, agentId: sessionAgentId, storePath, canonicalKey } = selectedSession;
    const readTranscriptOwner = async () => {
      if (!requestedSessionId) {
        return true;
      }
      const transcript = await readSessionHistoryPageInWorker(
        {
          kind: "transcript-binding",
          params: {
            target: { agentId: sessionAgentId, sessionId: requestedSessionId, storePath },
          },
        },
        signal,
      );
      return Boolean(
        transcript &&
        scopeLegacySessionKeyToAgent({
          sessionKey: transcript.sessionKey,
          agentId: sessionAgentId,
        }) === scopeLegacySessionKeyToAgent({ sessionKey: canonicalKey, agentId: sessionAgentId }),
      );
    };
    if (!(await readTranscriptOwner())) {
      if (retainedTranscript) {
        respondChatHistoryUnavailable(
          method,
          respond,
          "retained transcript is no longer available",
        );
      } else {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "sessionId does not belong to sessionKey"),
        );
      }
      return;
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
    const max = limit ?? 200;
    const maxHistoryBytes = Math.min(maxBytes ?? Infinity, getMaxChatHistoryMessagesBytes());
    const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(maxChars);
    const pendingInputs =
      sessionId && sessionId === entry?.sessionId
        ? await readChatPendingInputs(
            {
              agentId: sessionAgentId,
              sessionKey: canonicalKey,
              sessionId,
              storePath,
            },
            {
              before: pendingBefore,
              limit: max,
              maxChars: effectiveMaxChars,
              queuedTurns: context.chatQueuedTurns,
              cronStorePath: context.cronStorePath,
            },
          )
        : { items: [], total: 0 };
    // Receipts belong to the currently selected physical session, never archived history.
    const inputReceipts = inputRunIds
      ? !messageId && sessionId && sessionId === entry?.sessionId
        ? listSessionPendingInputReceipts(
            { agentId: sessionAgentId, sessionKey: canonicalKey, sessionId, storePath },
            { runIds: inputRunIds },
          ).map((receipt) =>
            receipt.state === "pending" &&
            isQueuedChatTurnForSession(context.chatQueuedTurns, receipt.runId, {
              agentId: sessionAgentId,
              sessionKey: canonicalKey,
              sessionId,
            })
              ? { runId: receipt.runId, state: receipt.state, queued: true as const }
              : receipt,
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
                  // Internal adapters may inspect message objects before responding.
                  encodeResponse: acceptsSerializedJson && method === req.method,
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
    const responsePage = historyPage.encodedResponse
      ? {
          ...historyPage.encodedResponse,
          messages: new SerializedJsonArray(historyPage.encodedResponse.messages),
        }
      : prepareChatHistoryResponsePage(historyPage, {
          entry: historyEntry,
          maxHistoryBytes,
          messageId,
        });
    const { messages, messagesBytes, responseHistoryBytes, omission, ...responseFields } =
      responsePage;
    if (omission) {
      reportOmittedChatHistory({
        ...omission,
        maxHistoryBytes: responseHistoryBytes,
        logDebug: (message) => context.logGateway.debug(message),
      });
    }
    const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
    const startupProjection = await (startupProjectionPromise ?? readStartupProjection());
    const startupMetadata = method === "chat.startup" ? startupProjection?.metadata : undefined;
    const { sessionModelCatalog, defaultModelCatalog } = startupProjection ?? {};
    const modelReadScope = {
      context,
      client,
      agentId: sessionAgentId,
      catalog: defaultModelCatalog,
    };
    const query = {
      key: canonicalKey,
      agentId: sessionAgentId,
      storePath,
    };
    const publishDelta = await withReadySessionRows(rowProjection, queries, (read) => {
      const currentSharing = readCurrentSharing(read);
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
      const activeRunState = resolveVisibleActiveSessionRunState({
        context,
        requestedKey: sessionKey,
        canonicalKey,
        sessionId,
        ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
        defaultAgentId: compatibilityOwnerAgentId,
        // History stays active until the terminal row is queryable or its write fails.
        includeTerminalPersistence: true,
      });
      if (sessionInfo) {
        sessionInfo.hasActiveRun = activeRunState.active;
        if (activeRunState.runIds !== undefined) {
          sessionInfo.activeRunIds = activeRunState.runIds;
        }
        if (activeRunState.active) {
          sessionInfo.status = activeRunState.status ?? "running";
        }
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
          agentId: sessionAgentId,
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
          return withReadySessionRows(rowProjection, queries, (publicationRead) => {
            const publicationSharing = readCurrentSharing(publicationRead);
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
              getMessagesBytes: () => delta.messagesBytes,
              maxBytes: maxHistoryBytes - delta.activityBytes,
            });
            const payload = {
              kind: "delta",
              messages: delta.messages,
              ...(delta.activity.length > 0 ? { activity: delta.activity } : {}),
              deltaCursor: delta.deltaCursor,
              pendingInputs,
              ...(inputReceipts ? { inputReceipts, inputConsumptions } : {}),
              sessionInfo,
              ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
              ...(startupMetadata ? { metadata: startupMetadata } : {}),
            };
            respond(true, projectOperatorModelRead(modelReadScope, payload));
            return undefined;
          });
        };
      }
      const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
        snapshot: inFlightRun,
        messages: [],
        getMessagesBytes: () => messagesBytes,
        maxBytes: responseHistoryBytes,
      });
      const payload = {
        sessionKey,
        sessionId,
        messages,
        ...responseFields,
        pendingInputs,
        ...(inputReceipts ? { inputReceipts, inputConsumptions } : {}),
        ...(historyPage.deltaCursor ? { deltaCursor: historyPage.deltaCursor } : {}),
        ...(historyPage.windowReset ? { windowReset: true } : {}),
        ...(historyPage.responseOffset !== undefined ? { offset: historyPage.responseOffset } : {}),
        defaults,
        sessionInfo,
        thinkingLevel,
        fastMode: entry?.fastMode,
        toolOverrides: entry?.toolOverrides,
        verboseLevel,
        ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
        ...(startupMetadata ? { metadata: startupMetadata } : {}),
      };
      if (retainedTranscript) {
        return () =>
          selection.publishRetainedTranscript({
            verify: async () =>
              (await readTranscriptOwner()) &&
              ((await retainedTranscript.verifyRetainedState?.()) ?? true),
            requireCurrentSession: retainedTranscript.requireCurrentSession === true,
            sharing: currentSharing,
            publish: () => respond(true, projectOperatorModelRead(modelReadScope, payload)),
          });
      }
      respond(true, projectOperatorModelRead(modelReadScope, payload));
      return undefined;
    });
    await publishDelta?.();
  } finally {
    selection.release();
  }
}

export const chatHistoryHandlers: GatewayRequestHandlers = {
  "chat.history": (opts) => handleChatHistoryRequest({ ...opts, method: "chat.history" }),
  "chat.startup": (opts) =>
    handleChatStartupRequest(opts, handleChatHistoryRequest, respondChatHistoryUnavailable),
  "chat.metadata": handleChatMetadataRequest,
};
