import { randomUUID } from "node:crypto";
import type {
  ErrorShape,
  QuestionResolveParams,
  SessionsPatchResult,
} from "../../packages/gateway-protocol/src/index.js";
import { CHAT_HISTORY_MAX_ENTRIES } from "../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { agentCommandFromIngress } from "../agents/agent-command.js";
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import { findAgentRunTerminalOutcome } from "../agents/agent-run-terminal-error.js";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  isDefinitiveRunLifecycle,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { resolveAgentVerboseDefault, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { ensureContextWindowCacheLoaded } from "../agents/context.js";
import { claimPendingEmbeddedAgentQuestionAnswer } from "../agents/embedded-agent-runner/runs.js";
import { resolveThinkingDefault } from "../agents/model-selection.js";
import { resolvePublishedModelCatalogOwner } from "../agents/prepared-model-catalog-owner.js";
import {
  readPreparedModelCatalog,
  loadPreparedModelCatalogSnapshot,
  withPreparedModelCatalogOwner,
} from "../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { bindEmbeddedSessionRowProjection } from "../agents/tools/embedded-gateway-stub.js";
import { resolveTextCommand } from "../auto-reply/commands-registry.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import { executeSessionGoalCommand, parseGoalCommand } from "../auto-reply/reply/commands-goal.js";
import { resolveQueueSettingsCore } from "../auto-reply/reply/queue/settings.js";
import { DEFAULT_QUEUE_DEBOUNCE_MS } from "../auto-reply/reply/queue/state.js";
import { createDraftStreamLoop } from "../channels/draft-stream-loop.js";
import { createDefaultDeps } from "../cli/deps.js";
import {
  captureRuntimeConfigAsyncReader,
  getRuntimeConfig,
  registerConfigWriteListener,
} from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionPatchProjection } from "../config/sessions/session-accessor.js";
import {
  mergeAssistantText,
  resolveAssistantTextInput,
} from "../gateway/agent-event-assistant-text.js";
import { resolveEffectiveChatHistoryMaxChars } from "../gateway/chat-display-projection.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  getMaxChatHistoryMessagesBytes,
  replaceOversizedChatHistoryMessages,
} from "../gateway/chat-history-budget.js";
import { enrichChatHistoryCompactionMarkers } from "../gateway/chat-history-response-page.js";
import {
  capLiveAssistantText,
  shouldSuppressAssistantEventForLiveChat,
} from "../gateway/live-chat-projector.js";
import { readChatHistoryPage } from "../gateway/server-methods/chat-history-pages.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { createGatewaySession } from "../gateway/session-create-service.js";
import { performGatewaySessionReset } from "../gateway/session-reset-service.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../gateway/session-row-projection.js";
import { capArrayByJsonBytes } from "../gateway/session-transcript-readers.js";
import { projectSessionPatchResult } from "../gateway/session-utils-model.js";
import {
  loadGatewaySessionEntryReadOnlyInWorker,
  resolveGatewaySessionStoreTargetInWorker,
} from "../gateway/session-utils-store-worker.js";
import {
  getSessionDefaults,
  listAgentsForGateway,
  resolveCanonicalGatewaySessionStoreKey,
  resolveSessionModelRef,
} from "../gateway/session-utils.js";
import { projectSessionsPatchEntry } from "../gateway/sessions-patch.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import { type AgentEventRuntimePayload, onAgentEvent } from "../infra/agent-events.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  clearEmbeddedPluginApprovalBroker,
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import {
  clearEmbeddedQuestionBroker,
  EmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "../infra/embedded-question-broker.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  agentSessionKeysMatchByRequestKey,
  isIncognitoSessionKey,
  normalizeAgentId,
} from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { waitForQueueDebounce } from "../utils/queue-helpers.js";
import {
  assistantChatMessage,
  payloadText,
  projectLocalRunText,
  resolveDeltaPayload,
  resolveTerminalChatState,
} from "./embedded-chat-projection.js";
import { ensureEmbeddedHistoryRuntimePluginsLoaded } from "./embedded-history-runtime.js";
import { enqueuePendingLocalMessage, findQueuedSessionRun } from "./embedded-local-queue.js";
import {
  buildLocalQueuedPrompt,
  createLocalRunState,
  isSameLocalRunScope,
  timeoutSecondsFromMs,
  waitForLocalRunShutdown,
  waitForQueuedLocalRun,
  type LocalRunState,
} from "./embedded-local-run.js";
import { EmbeddedPreparedModelRuntimeHost } from "./embedded-prepared-runtime.js";
import { embeddedSessionStartupMigrationLog, silentRuntime } from "./embedded-runtime.js";
import {
  createEmbeddedSessionReader,
  readEmbeddedHistorySession,
  readEmbeddedHistorySessionInfo,
  readEmbeddedPrivateHistorySessionInfo,
} from "./embedded-session-reader.js";
import { steerEmbeddedSessionInput } from "./embedded-session-steering.js";
import type {
  ChatSendOptions,
  TuiAgentsList,
  TuiApprovalDecision,
  TuiBackend,
  TuiChatSendResult,
  TuiEvent,
  TuiModelChoice,
  TuiSessionCreateOptions,
  TuiImageRequest,
  TuiImageData,
} from "./tui-backend.js";
import { formatTuiErrorMessage } from "./tui-formatters.js";

export class EmbeddedTuiBackend implements TuiBackend {
  readonly connection = { url: "local embedded" };

  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;

  private readonly deps = createDefaultDeps();
  private readonly localSenderId = randomUUID();
  private readonly runs = new Map<string, LocalRunState>();
  private unsubscribe?: () => void;
  private previousRuntimeLog?: typeof defaultRuntime.log;
  private previousRuntimeError?: typeof defaultRuntime.error;
  private seq = 0;
  private readonly pendingLifecycleErrors = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scheduler = new GatewayScheduler();
  private readonly emitBrokerEvent = (event: { event: string; payload: unknown }) => {
    if (!this.scheduler.signal.aborted) {
      this.emit(event.event, event.payload);
    }
  };
  private readonly pluginApprovalBroker = new EmbeddedPluginApprovalBroker(this.emitBrokerEvent);
  private readonly questionBroker = new EmbeddedQuestionBroker(
    this.scheduler,
    this.emitBrokerEvent,
  );
  private readonly preparedModelRuntime = new EmbeddedPreparedModelRuntimeHost();
  private unsubscribeConfigWrites?: () => void;
  private sessionProjection?: Promise<SessionRowProjection>;
  private unbindSessionProjection?: () => void;
  // Store methods await migration and the shared resident session rows.
  private ready: Promise<void> = Promise.resolve();
  private readonly sessionReader = createEmbeddedSessionReader({
    ready: () => this.ready,
    projection: () => this.sessionProjection,
  });

  start() {
    if (this.unsubscribe) {
      return;
    }
    setEmbeddedMode(true);
    void ensureContextWindowCacheLoaded();
    // Suppress console output from logError/logInfo that would pollute the TUI.
    // File logger (getLogger()) still captures everything via logger.ts:35.
    this.previousRuntimeLog = defaultRuntime.log;
    this.previousRuntimeError = defaultRuntime.error;
    defaultRuntime.log = silentRuntime.log;
    defaultRuntime.error = silentRuntime.error;
    // Keep this synchronous so the shared event bus can isolate listener failures.
    this.unsubscribe = onAgentEvent((evt) => this.handleAgentEvent(evt));
    setEmbeddedPluginApprovalBroker(this.pluginApprovalBroker);
    setEmbeddedQuestionBroker(this.questionBroker);
    // Local mode shares the Gateway's session-store readiness checks.
    this.sessionProjection = (async () => {
      const config = await captureRuntimeConfigAsyncReader()();
      const { runSessionStartupMigration } =
        await import("../config/sessions/startup-migration-runtime.js");
      await runSessionStartupMigration({
        cfg: config,
        env: process.env,
        log: embeddedSessionStartupMigrationLog,
      });
      // Maintenance can retire auth read owners; publish only after it finishes.
      this.unsubscribeConfigWrites = registerConfigWriteListener((event) => {
        this.preparedModelRuntime.publish(event.runtimeConfig);
      });
      this.preparedModelRuntime.publish(getRuntimeConfig());
      return createSessionRowProjection({ cfg: getRuntimeConfig(), getConfig: getRuntimeConfig });
    })();
    this.ready = this.sessionProjection.then(() => {});
    void this.ready.catch(() => {});
    this.unbindSessionProjection = bindEmbeddedSessionRowProjection(this.sessionProjection);
    queueMicrotask(() => {
      this.onConnected?.();
    });
  }

  async stop() {
    this.scheduler.beginClose();
    clearEmbeddedPluginApprovalBroker(this.pluginApprovalBroker);
    clearEmbeddedQuestionBroker(this.questionBroker);
    const maintenancePromises: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      run.textUpdates?.stop();
      if (run.finishing || run.lifecycleEnded) {
        if (run.promise) {
          maintenancePromises.push(run.promise);
        }
        continue;
      }
      run.controller.abort();
    }
    this.pluginApprovalBroker.stop();
    this.questionBroker.stop();
    await this.scheduler.stop();
    const maintenanceCompleted = await waitForLocalRunShutdown(maintenancePromises);
    if (!maintenanceCompleted) {
      for (const run of this.runs.values()) {
        if (run.finishing || run.lifecycleEnded) {
          run.controller.abort();
        }
      }
    }
    // Abort is a cancellation request, not settlement. Keep the runtime and
    // session projection alive until every owned run finishes its cleanup.
    await Promise.allSettled([...this.runs.values()].flatMap((run) => run.promise ?? []));
    this.unbindSessionProjection?.();
    this.unbindSessionProjection = undefined;
    const projection = this.sessionProjection;
    this.sessionProjection = undefined;
    await projection?.catch(() => undefined).then((value) => value?.dispose());
    this.unsubscribeConfigWrites?.();
    this.unsubscribeConfigWrites = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pendingLifecycleErrors.forEach(clearTimeout);
    this.pendingLifecycleErrors.clear();
    defaultRuntime.log = this.previousRuntimeLog ?? defaultRuntime.log;
    defaultRuntime.error = this.previousRuntimeError ?? defaultRuntime.error;
    this.previousRuntimeLog = undefined;
    this.previousRuntimeError = undefined;
    setEmbeddedMode(false);
    await this.preparedModelRuntime.waitUntilReady();
  }

  async sendChat(options: ChatSendOptions): Promise<TuiChatSendResult> {
    await this.ready;
    await this.preparedModelRuntime.waitUntilReady();
    this.scheduler.signal.throwIfAborted();
    const runId = options.runId ?? randomUUID();
    const command = resolveTextCommand(options.message);
    const explicitFollowup = command?.command.key === "followup";
    let opts = options;
    if (explicitFollowup) {
      if (!command.args) {
        throw new Error("Usage: /followup <message>");
      }
      opts = { ...options, message: command.args };
    }
    const sideCommand = /^\/(?:btw|side)(?::|\s)+(.*)$/i.exec(opts.message.trim());
    const question = !explicitFollowup ? sideCommand?.[1]?.trim() || undefined : undefined;
    const isQueueCommand = !explicitFollowup && command?.command.key === "queue";
    const agentId = resolveSessionAgentId({
      sessionKey: opts.sessionKey,
      config: getRuntimeConfig(),
      agentId: opts.agentId,
    });
    const runScope = {
      sessionKey: opts.sessionKey,
      agentId,
    };
    // Readiness awaits follow synchronous run registration, so the same owned
    // promise determines both stop admission and the next turn's queue predecessor.
    const sessionRun = findQueuedSessionRun(this.runs, runScope);
    const stopCommand =
      !explicitFollowup && sessionRun !== undefined && isAbortRequestText(opts.message);
    const queuedAfter = question || stopCommand || isQueueCommand ? undefined : sessionRun;
    if (stopCommand) {
      this.abortSessionRuns(runScope);
      return { runId };
    }
    let pendingQueue: LocalRunState["pendingQueue"];
    if (queuedAfter) {
      const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
      const {
        cfg,
        canonicalKey,
        entry,
        storePath,
        agentId: storedAgentId,
      } = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getRuntimeConfig(),
        key: opts.sessionKey,
        ...loadOptions,
      });
      this.scheduler.signal.throwIfAborted();
      const activeOperation = getSessionControllerOperation(
        canonicalKey,
        captureSessionTarget({
          storeScope: storePath,
          sessionKey: canonicalKey,
          aliases: [opts.sessionKey],
          agentId: storedAgentId,
          incarnation: entry?.sessionId,
        }),
      );
      if (activeOperation && !explicitFollowup) {
        const claimed = await claimPendingEmbeddedAgentQuestionAnswer(
          activeOperation,
          opts.message,
        );
        if (claimed) {
          return claimed;
        }
        this.scheduler.signal.throwIfAborted();
      }
      let queueSettings = resolveQueueSettingsCore({
        cfg,
        channel: INTERNAL_MESSAGE_CHANNEL,
        sessionEntry: entry,
        ...(explicitFollowup ? { inlineMode: "followup" as const } : {}),
      });
      if (queueSettings.mode === "steer") {
        if (activeOperation) {
          const steer = await steerEmbeddedSessionInput({
            operation: activeOperation,
            text: opts.message,
            senderId: this.localSenderId,
            sessionEntry: entry,
            debounceMs: queueSettings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS,
            abortSignal: this.scheduler.signal,
          });
          if (steer.status === "indeterminate") {
            // Consumed without a confirmed commit: queuing it again could duplicate it.
            throw new Error(steer.errorMessage);
          }
          if (steer.status === "accepted") {
            if (steer.result?.transcriptCommit === "unconfirmed") {
              throw new Error(steer.result.errorMessage);
            }
            return { runId: queuedAfter.runId };
          }
        }
        this.scheduler.signal.throwIfAborted();
        queueSettings = { ...queueSettings, mode: "followup" };
      }
      if (queueSettings.mode === "interrupt") {
        this.abortSessionRuns(runScope);
      } else {
        const queued = enqueuePendingLocalMessage(this.runs, {
          runScope,
          message: opts.message,
          settings: queueSettings,
        });
        if (queued.kind === "rejected") {
          if (explicitFollowup) {
            throw new Error("Your followup was not queued because the session queue is full.");
          }
          return { runId: queuedAfter.runId };
        }
        if (queued.kind === "handled") {
          return { runId: queued.runId };
        }
        pendingQueue = queued.queue;
      }
    }
    const run = createLocalRunState(runId, {
      sessionKey: opts.sessionKey,
      agentId,
      question,
      ...(explicitFollowup ? { explicitFollowup: true as const } : {}),
      ...(pendingQueue ? { pendingQueue } : {}),
      ...(queuedAfter ? { queuedAfter } : {}),
    });
    this.runs.set(runId, run);

    const runPromise = (run.promise = this.runTurn(runId, run, opts));

    if (isQueueCommand) {
      // Queue directives are control-plane mutations. Complete them before
      // admitting another local prompt so later sends cannot overtake the new mode.
      await runPromise;
    }

    return { runId, ...(explicitFollowup && queuedAfter ? { status: "queued" } : {}) };
  }

  async abortChat(opts: { sessionKey: string; agentId?: string; runId?: string }) {
    const runIds: string[] = [];
    const candidates = opts.runId ? [[opts.runId, this.runs.get(opts.runId)] as const] : this.runs;
    for (const [runId, run] of candidates) {
      if (!run || (!opts.runId && run.question) || run.sessionKey !== opts.sessionKey) {
        continue;
      }
      if (opts.sessionKey === "global") {
        const defaultAgentId =
          opts.agentId && run.agentId ? undefined : resolveDefaultAgentId(getRuntimeConfig());
        const requestedAgentId = opts.agentId ? normalizeAgentId(opts.agentId) : defaultAgentId;
        const runAgentId = run.agentId ? normalizeAgentId(run.agentId) : defaultAgentId;
        if (runAgentId !== requestedAgentId) {
          continue;
        }
      }
      if (!this.isAbortableRun(run)) {
        continue;
      }
      run.controller.abort();
      runIds.push(runId);
    }
    return { ok: true, aborted: runIds.length > 0, runIds };
  }

  async loadImage(opts: TuiImageRequest): Promise<TuiImageData> {
    const { loadEmbeddedImage } = await import("./embedded-image-loader.js");
    return await loadEmbeddedImage(opts);
  }

  async loadHistory(opts: { sessionKey: string; agentId?: string; limit?: number }) {
    await this.ready;
    await this.preparedModelRuntime.waitUntilReady();
    const selected = await readEmbeddedHistorySession(opts);
    const { cfg, agentId: sessionAgentId, storePath, readSource, entry, canonicalKey } = selected;
    const sessionId = entry?.sessionId;
    const runtimePluginsPrewarm = ensureEmbeddedHistoryRuntimePluginsLoaded({
      cfg,
      sessionAgentId,
    });
    const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const max = Math.min(CHAT_HISTORY_MAX_ENTRIES, opts.limit ?? 200);
    const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
    const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars();
    const historyPage = await readChatHistoryPage({
      entry,
      provider: resolvedSessionModel.provider,
      sessionId,
      storePath,
      sessionAgentId,
      canonicalKey,
      max,
      maxHistoryBytes,
      effectiveMaxChars,
      offset: undefined,
      messageId: undefined,
    });
    const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, entry);
    const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
    const byteCounter = createChatHistoryByteCounter(activity);
    const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    const replaced = replaceOversizedChatHistoryMessages({
      messages: normalized,
      byteCounter,
      maxSingleMessageBytes: perMessageHardCap,
    });
    const messages = capArrayByJsonBytes(
      replaced.messages,
      maxHistoryBytes - byteCounter.framingBytes(replaced.messages),
      byteCounter.messageBytes,
    ).items;
    const newestInFlightRun = [...this.runs.entries()].findLast(
      ([, run]) =>
        !run.question &&
        run.terminalState !== "final" &&
        agentSessionKeysMatchByRequestKey(run.sessionKey, opts.sessionKey) &&
        normalizeAgentId(run.agentId) === normalizeAgentId(sessionAgentId),
    );
    const inFlightRun = newestInFlightRun
      ? {
          runId: newestInFlightRun[0],
          text: projectLocalRunText(newestInFlightRun[1]).text.trim(),
        }
      : undefined;

    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const catalog = await readPreparedModelCatalog({
        config: cfg,
        agentId: sessionAgentId,
        readOnly: true,
      });
      thinkingLevel = resolveThinkingDefault({
        cfg,
        agentId: sessionAgentId,
        provider: resolvedSessionModel.provider,
        model: resolvedSessionModel.model,
        catalog,
      });
    }

    const defaults = getSessionDefaults(cfg, undefined, { allowPluginNormalization: false });
    const projection = await this.sessionProjection;
    const target = {
      key: canonicalKey,
      agentId: sessionAgentId,
      storePath: readSource?.path ?? storePath,
    };
    const privateEntry = entry && (entry.incognito || isIncognitoSessionKey(canonicalKey));
    const sessionInfo = privateEntry
      ? await readEmbeddedPrivateHistorySessionInfo(selected, entry)
      : entry && projection
        ? await readEmbeddedHistorySessionInfo(projection, target, {
            sessionId,
            lifecycleRevision: entry.lifecycleRevision,
          })
        : undefined;
    const verboseLevel = entry?.verboseLevel ?? resolveAgentVerboseDefault(cfg, sessionAgentId);
    if (sessionInfo) {
      sessionInfo.thinkingLevel = thinkingLevel;
      sessionInfo.verboseLevel = verboseLevel;
    }

    return {
      sessionKey: opts.sessionKey,
      sessionId,
      messages,
      defaults,
      activity: messages.flatMap((message) => activity.get(message) ?? []),
      ...(sessionInfo ? { sessionInfo } : {}),
      thinkingLevel,
      fastMode: entry?.fastMode,
      verboseLevel,
      runtimePluginsPrewarm,
      ...(inFlightRun ? { inFlightRun } : {}),
    };
  }

  listSessions = this.sessionReader.listSessions;
  describeSession = this.sessionReader.describeSession;

  async listAgents(): Promise<TuiAgentsList> {
    return await listAgentsForGateway(getRuntimeConfig());
  }

  async patchSession(
    opts: Parameters<TuiBackend["patchSession"]>[0],
  ): Promise<SessionsPatchResult> {
    await this.ready;
    await this.preparedModelRuntime.waitUntilReady();
    const cfg = getRuntimeConfig();
    const target = await resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key: opts.key,
      agentId: opts.agentId,
    });
    const applied = await applySessionPatchProjection<{ ok: false; error: ErrorShape }>({
      ...(opts.label === undefined ? { sessionKeys: target.storeKeys } : {}),
      storePath: target.storePath,
      resolveTarget: ({ store }) => {
        const { target: migratedTarget, primaryKey } = resolveCanonicalGatewaySessionStoreKey({
          cfg,
          key: opts.key,
          store: store as Record<string, SessionEntry>,
          agentId: opts.agentId,
          target,
        });
        return { primaryKey, candidateKeys: migratedTarget.storeKeys };
      },
      project: async ({ primaryKey, existingEntry, isLabelInUse }) =>
        await projectSessionsPatchEntry({
          cfg,
          existingEntry,
          isLabelInUse,
          storeKey: primaryKey,
          agentId: target.agentId,
          patch: opts,
          loadGatewayModelCatalogSnapshot: () =>
            loadPreparedModelCatalogSnapshot({
              config: cfg,
              agentId: target.agentId,
              readOnly: true,
            }),
        }),
    });
    if (!applied.ok) {
      throw new Error(applied.error.message);
    }

    const canonicalKey = target.canonicalKey ?? opts.key;
    const [acpMeta] = await readAcpSessionMetaForEntries({
      cfg,
      entries: [{ agentId: target.agentId, sessionKey: canonicalKey, entry: applied.entry }],
    });
    const projected = projectSessionPatchResult({
      canonicalKey,
      cfg,
      entry: applied.entry,
      preparedAcpMeta: acpMeta ?? null,
      storePath: target.storePath,
      targetAgentId: target.agentId,
    });
    return { ...projected, entry: { ...projected.entry } };
  }

  async resetSession(key: string, reason?: "new" | "reset", opts?: { agentId?: string }) {
    await this.ready;
    if (
      (await loadGatewaySessionEntryReadOnlyInWorker({ cfg: getRuntimeConfig(), key, ...opts }))
        .entry?.incognito === true
    ) {
      throw new Error("Incognito sessions cannot reset in place.");
    }
    const result = await performGatewaySessionReset({
      key,
      operatorRoleActor: { kind: "system" },
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      reason: reason === "new" ? "new" : "reset",
      commandSource: "tui:embedded",
      armSessionDiffBaselineCapture: true,
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    if ("incognitoDeleted" in result) {
      return { ok: true as const, key: result.key, deleted: true as const };
    }
    return { ok: true as const, key: result.key, entry: result.entry, resolved: result.resolved };
  }

  async createSession(opts: TuiSessionCreateOptions) {
    await this.ready;
    await this.preparedModelRuntime.waitUntilReady();
    const cfg = getRuntimeConfig();
    const result = await createGatewaySession({
      cfg,
      operatorRoleActor: { kind: "system" },
      ...opts,
      creation: { via: "operator", actor: { type: "human", source: "unknown" } },
      armSessionDiffBaselineCapture: true,
      emitCommandHooks: Boolean(opts.parentSessionKey),
      commandSource: "tui:embedded",
      loadGatewayModelCatalogSnapshot: () =>
        loadPreparedModelCatalogSnapshot({
          config: cfg,
          agentId: resolveSessionAgentId({
            sessionKey: opts.key,
            config: cfg,
            agentId: opts.agentId,
          }),
          readOnly: true,
        }),
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return {
      ok: true as const,
      key: result.key,
      entry: result.entry,
      resolved: result.resolved,
    };
  }

  private async runBtwTurn(params: {
    runId: string;
    sessionKey: string;
    agentId?: string;
    question: string;
    timeoutMs?: number;
    controller: AbortController;
  }) {
    const loadOptions = params.agentId ? { agentId: params.agentId } : undefined;
    const {
      cfg,
      agentId: sessionAgentId,
      canonicalKey,
      storePath,
      store,
      entry,
    } = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getRuntimeConfig(),
      key: params.sessionKey,
      ...loadOptions,
    });
    if (!entry?.sessionId) {
      throw new Error("/btw requires an active session with existing context.");
    }
    const resolvedModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const timeoutSeconds = timeoutSecondsFromMs(params.timeoutMs);
    const { runBtwSideQuestion } = await import("../agents/btw.js");
    const reply = await runBtwSideQuestion({
      cfg,
      agentId: sessionAgentId,
      agentDir: resolveAgentDir(cfg, sessionAgentId),
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      question: params.question,
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: canonicalKey,
      storePath,
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      opts: {
        runId: params.runId,
        abortSignal: params.controller.signal,
        ...(timeoutSeconds !== undefined ? { timeoutOverrideSeconds: Number(timeoutSeconds) } : {}),
      },
      isNewSession: false,
      messageChannel: INTERNAL_MESSAGE_CHANNEL,
      messageProvider: INTERNAL_MESSAGE_CHANNEL,
      currentChannelId: INTERNAL_MESSAGE_CHANNEL,
      senderId: this.localSenderId,
    });
    const text = reply?.text?.trim() ?? "";
    if (!text) {
      throw new Error("/btw produced no answer.");
    }
    return {
      sessionKey: canonicalKey,
      text,
      isError: reply?.isError === true,
    };
  }

  async getGatewayStatus() {
    return `local embedded mode${this.runs.size > 0 ? ` (${String(this.runs.size)} active run${this.runs.size === 1 ? "" : "s"})` : ""}`;
  }

  async listPluginApprovals(): Promise<unknown> {
    return this.pluginApprovalBroker.listPending();
  }

  async listQuestions() {
    return this.questionBroker.list();
  }

  async getQuestion(id: string) {
    return this.questionBroker.get({ id });
  }

  async resolveQuestion(params: QuestionResolveParams) {
    return this.questionBroker.resolve(params);
  }

  async resolvePluginApproval(id: string, decision: TuiApprovalDecision) {
    return { ok: this.pluginApprovalBroker.resolve(id, decision) };
  }

  async listModels(opts?: { agentId?: string; sessionKey?: string }): Promise<TuiModelChoice[]> {
    await this.ready;
    await this.preparedModelRuntime.waitUntilReady();
    const cfg = getRuntimeConfig();
    const agentId = opts?.agentId ?? resolveDefaultAgentId(cfg);
    return await withPreparedModelCatalogOwner(
      { config: cfg, agentId, readOnly: true },
      async (snapshot) =>
        (
          await buildModelsListResult({
            source: {
              kind: "published",
              owner: {
                ...resolvePublishedModelCatalogOwner(snapshot),
                authMaterializations: getPreparedModelRuntimeAuthMaterializations(snapshot),
              },
            },
            agentId,
            params: { includeDetails: true },
          })
        ).models,
    );
  }

  async runGoalCommand(opts: Parameters<NonNullable<TuiBackend["runGoalCommand"]>>[0]) {
    await this.ready;
    const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
    const { agentId, canonicalKey, storePath, entry } =
      await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getRuntimeConfig(),
        key: opts.sessionKey,
        ...loadOptions,
      });
    const parsed = parseGoalCommand(opts.command.trim());
    if (!parsed) {
      throw new Error("invalid goal command");
    }

    const result = await executeSessionGoalCommand({
      parsed,
      sessionKey: canonicalKey,
      storePath,
      fallbackEntry: entry ?? { sessionId: randomUUID(), updatedAt: Date.now() },
      agentId,
    });
    return result.continuationPrompt
      ? { text: result.text, continuationPrompt: result.continuationPrompt }
      : { text: result.text };
  }

  async runUsageCostCommand(opts: Parameters<NonNullable<TuiBackend["runUsageCostCommand"]>>[0]) {
    await this.ready;
    const { cfg, agentId, canonicalKey, storePath, entry } =
      await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getRuntimeConfig(),
        key: opts.sessionKey,
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
      });
    const { formatSessionUsageCostSummary } =
      await import("../auto-reply/reply/commands-session-cost.runtime.js");
    return {
      text: await formatSessionUsageCostSummary({
        cfg,
        sessionKey: canonicalKey,
        agentId,
        sessionEntry: entry,
        storePath,
      }),
    };
  }

  private abortSessionRuns(params: { sessionKey: string; agentId?: string }) {
    for (const run of this.runs.values()) {
      if (isSameLocalRunScope(run, params) && !run.question && this.isAbortableRun(run)) {
        run.controller.abort();
      }
    }
  }

  private isAbortableRun(run: LocalRunState): boolean {
    return !run.lifecycleEnded || run.promise !== undefined;
  }

  private emit(event: string, payload: unknown) {
    this.onEvent?.({
      event,
      payload,
      seq: ++this.seq,
    });
  }

  private emitRun(
    event: "chat" | "agent",
    runId: string,
    run: LocalRunState,
    payload: Record<string, unknown>,
  ) {
    this.emit(event, { runId, sessionKey: run.sessionKey, agentId: run.agentId, ...payload });
  }

  private clearPendingLifecycleError(runId: string) {
    clearTimeout(this.pendingLifecycleErrors.get(runId));
    this.pendingLifecycleErrors.delete(runId);
  }

  private scheduleChatError(runId: string, run: LocalRunState, errorMessage?: string) {
    this.clearPendingLifecycleError(runId);
    const timer = setTimeout(() => {
      this.pendingLifecycleErrors.delete(runId);
      this.emitChatTerminal(runId, run, "error", errorMessage, "provisional");
    }, AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
    timer.unref?.();
    this.pendingLifecycleErrors.set(runId, timer);
  }

  private emitChatDelta(runId: string, run: LocalRunState) {
    const projected = projectLocalRunText(run);
    const text = projected.text.trim();
    if (run.buffer && (!text || projected.suppress)) {
      return;
    }
    const deltaPayload = resolveDeltaPayload(text, run.lastBroadcastText);
    if (!deltaPayload.deltaText && !deltaPayload.replace) {
      return;
    }
    run.registered = true;
    run.lastBroadcastText = text;
    this.emitRun("chat", runId, run, {
      state: "delta",
      ...deltaPayload,
      message: assistantChatMessage(text),
    });
  }

  private flushChatDelta(runId: string, run: LocalRunState) {
    if (run.textUpdates?.takePending()) {
      this.emitChatDelta(runId, run);
    }
  }

  private emitChatTerminal(
    runId: string,
    run: LocalRunState,
    state: "final" | "aborted" | "error",
    detail?: string,
    terminalState: "provisional" | "final" = "final",
  ) {
    this.clearPendingLifecycleError(runId);
    if (run.terminalState === "final" || run.terminalState === terminalState) {
      return;
    }
    this.flushChatDelta(runId, run);
    run.textUpdates?.stop();
    run.terminalState = terminalState;
    if (terminalState === "final") {
      run.markQueuedRunReady();
      run.finishing = false;
      run.lifecycleEnded = true;
    }
    run.registered = true;
    run.lastBroadcastText = undefined;
    const projected = projectLocalRunText(run, true);
    const text = state === "final" && !projected.suppress ? projected.text.trim() : "";
    this.emitRun("chat", runId, run, {
      state,
      ...(state === "aborted" && run.localModelMayStillBeFinishing
        ? { localModelMayStillBeFinishing: true }
        : {}),
      ...(state === "final" && detail ? { stopReason: detail } : {}),
      ...(state === "final" && run.lifecycleYielded ? { yielded: true } : {}),
      ...(text ? { message: assistantChatMessage(text) } : {}),
      ...(state !== "final" && (detail || (state === "aborted" && run.toolErrorSummary))
        ? { errorMessage: formatTuiErrorMessage(detail ?? run.toolErrorSummary) }
        : {}),
    });
  }

  private projectTerminalOutcome(
    runId: string,
    run: LocalRunState,
    metadata: NonNullable<
      Parameters<typeof buildAgentRunTerminalOutcomeFromLifecycleEvent>[0]["data"]
    > & {
      aborted?: unknown;
      phase?: unknown;
      toolErrorSummary?: unknown;
    },
    options: {
      visibleText?: string;
      terminalOutcome?: AgentRunTerminalOutcome;
    } = {},
  ): boolean {
    const terminalError =
      metadata.error && typeof metadata.error === "object" && "message" in metadata.error
        ? metadata.error.message
        : metadata.error;
    const outcome =
      options.terminalOutcome ??
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: metadata.phase === "error" || terminalError ? "error" : "end",
        data: {
          ...metadata,
          error: terminalError ? formatTuiErrorMessage(terminalError) : undefined,
        },
        abortSignal: run.controller.signal,
      });
    const state = resolveTerminalChatState(outcome);
    if (!state) {
      return false;
    }
    const diagnostic =
      state === "aborted"
        ? readToolValidationErrorSummary(metadata.toolErrorSummary)
        : (outcome.reason === "failed" && options.visibleText) ||
          outcome.error ||
          (outcome.status === "timeout"
            ? "The provider timed out. Please try again."
            : "Agent run failed.");
    if (
      metadata.phase === "error" &&
      !isDefinitiveRunLifecycle({ phase: "error", data: metadata })
    ) {
      this.scheduleChatError(runId, run, diagnostic);
    } else {
      this.emitChatTerminal(runId, run, state, diagnostic);
    }
    return true;
  }

  private ensureRunRegistered(runId: string, run: LocalRunState) {
    if (run.registered || run.question) {
      return;
    }
    run.registered = true;
    run.lastBroadcastText = "";
    this.emitRun("chat", runId, run, {
      state: "delta",
      deltaText: "",
      message: assistantChatMessage(""),
    });
  }

  private handleAgentEvent(evt: AgentEventRuntimePayload) {
    const run = this.runs.get(evt.runId);
    if (!run) {
      return;
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : "";
    if (evt.stream !== "lifecycle" || lifecyclePhase !== "error") {
      this.clearPendingLifecycleError(evt.runId);
    }

    if (evt.stream !== "assistant") {
      this.flushChatDelta(evt.runId, run);
      this.ensureRunRegistered(evt.runId, run);
    }

    const explicitFollowupStarted = run.explicitFollowup && lifecyclePhase === "start";
    if (explicitFollowupStarted) {
      delete run.explicitFollowup;
    }
    this.emitRun("agent", evt.runId, run, {
      stream: evt.stream,
      data: explicitFollowupStarted ? { ...evt.data, explicitFollowup: true } : evt.data,
    });

    if (evt.stream === "assistant" || (evt.stream === "tool" && evt.data?.phase === "start")) {
      run.toolErrorSummary = undefined;
    } else if (evt.stream === "tool" && evt.data?.phase === "result") {
      run.toolErrorSummary = readToolValidationErrorSummary(evt.data.toolErrorSummary);
    }

    const assistantLiveChatInput = evt.assistantProjection
      ? resolveAssistantTextInput({
          ...evt.assistantProjection,
          managedMediaUrls: evt.data.managedMediaUrls,
        })
      : evt.stream === "assistant"
        ? resolveAssistantTextInput(evt.data)
        : undefined;
    if (
      assistantLiveChatInput &&
      !run.question &&
      !shouldSuppressAssistantEventForLiveChat(evt.data)
    ) {
      if (
        assistantLiveChatInput.text !== undefined ||
        assistantLiveChatInput.itemId !== run.assistantScope?.itemId
      ) {
        this.flushChatDelta(evt.runId, run);
      }
      for (const url of assistantLiveChatInput.managedMediaUrls ?? []) {
        run.managedMediaUrls.add(url);
      }
      const snapshot = mergeAssistantText(
        { text: run.buffer, scope: run.assistantScope },
        assistantLiveChatInput,
        "live",
      );
      run.assistantScope = snapshot.scope;
      run.buffer = capLiveAssistantText(snapshot);
      if (
        (snapshot.appendedText !== undefined || run.lastBroadcastText === undefined) &&
        !assistantLiveChatInput.replace
      ) {
        // Materialize snapshots at presentation cadence, before the TUI parses full messages.
        run.textUpdates ??= createDraftStreamLoop<boolean>({
          throttleMs: 75,
          coalesceInFlight: true,
          emptyValue: false,
          isEmpty: (pending) => !pending,
          isStopped: () => this.scheduler.signal.aborted || run.terminalState === "final",
          sendOrEditStreamMessage: async () => this.emitChatDelta(evt.runId, run),
        });
        run.textUpdates.update(true);
      } else {
        this.emitChatDelta(evt.runId, run);
      }
      return;
    }

    if (evt.stream !== "lifecycle") {
      return;
    }

    const phase = lifecyclePhase;
    if (phase === "finishing") {
      run.finishing = true;
      run.markQueuedRunReady();
      run.lifecycleStopReason =
        typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    run.finishing = false;
    if (phase === "error") {
      run.buffer = "";
      delete run.assistantScope;
    }
    if (this.projectTerminalOutcome(evt.runId, run, evt.data)) {
      return;
    }
    run.lifecycleEnded = true;
    run.markQueuedRunReady();
    run.lifecycleStopReason =
      typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
    run.lifecycleYielded = isAgentLifecycleYieldedWaiting(evt.data);
  }

  private async runTurn(runId: string, run: LocalRunState, opts: ChatSendOptions) {
    // This turn owns its state until finally; stop waits for every owned promise.
    const { controller, queuedAfter } = run;
    try {
      if (queuedAfter) {
        try {
          await Promise.race([
            waitForQueuedLocalRun(queuedAfter, runId),
            waitForAbortSignal(controller.signal),
          ]);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.emitChatTerminal(
            runId,
            run,
            "error",
            `previous run did not finish cleanly: ${errorMessage}`,
          );
          return;
        }
        if (controller.signal.aborted) {
          this.emitChatTerminal(runId, run, "aborted");
          return;
        }
      }
      delete run.queuedAfter;
      let message = opts.message;
      if (run.pendingQueue) {
        await waitForQueueDebounce(run.pendingQueue, controller.signal);
        if (controller.signal.aborted) {
          this.emitChatTerminal(runId, run, "aborted");
          return;
        }
        message = buildLocalQueuedPrompt(run.pendingQueue);
        delete run.pendingQueue;
      }
      if (queuedAfter) {
        // A turn may have queued behind another local run while a config write published a new
        // generation. Recheck at actual model admission so it cannot use stale facts.
        await this.preparedModelRuntime.waitUntilReady();
        if (controller.signal.aborted) {
          this.emitChatTerminal(runId, run, "aborted");
          return;
        }
      }
      if (run.question) {
        const result = await this.runBtwTurn({
          runId,
          sessionKey: opts.sessionKey,
          ...(opts.agentId ? { agentId: opts.agentId } : {}),
          question: run.question,
          timeoutMs: opts.timeoutMs,
          controller,
        });
        if (controller.signal.aborted) {
          this.emitChatTerminal(runId, run, "aborted");
          return;
        }
        this.emit("chat.side_result", {
          kind: "btw",
          runId,
          sessionKey: result.sessionKey,
          agentId: run.agentId,
          question: run.question,
          text: result.text,
          ...(result.isError ? { isError: true } : {}),
        });
        this.emitChatTerminal(runId, run, "final");
        return;
      }
      const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
      const { agentId, canonicalKey, entry } = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getRuntimeConfig(),
        key: opts.sessionKey,
        ...loadOptions,
      });
      const result = await agentCommandFromIngress(
        {
          // The per-message timestamp prefix is applied at the single LLM
          // boundary (normalizeMessagesForLlmBoundary) from each message's own
          // timestamp, so the current turn and historical turns carry identical
          // bytes on the wire. See: https://github.com/openclaw/openclaw/issues/3658
          message,
          sessionKey: canonicalKey,
          agentId,
          ...(entry?.sessionId ? { sessionId: entry.sessionId } : {}),
          thinking: opts.thinking,
          deliver: opts.deliver,
          channel: INTERNAL_MESSAGE_CHANNEL,
          runContext: {
            messageChannel: INTERNAL_MESSAGE_CHANNEL,
            senderId: this.localSenderId,
          },
          timeout: timeoutSecondsFromMs(opts.timeoutMs),
          runId,
          abortSignal: controller.signal,
          allowModelOverride: false,
        },
        silentRuntime,
        this.deps,
      );
      if (
        this.projectTerminalOutcome(runId, run, result?.meta ?? {}, {
          visibleText: payloadText(result?.payloads),
        })
      ) {
        return;
      }
      run.lifecycleYielded ||= isAgentLifecycleYieldedWaiting({ phase: "end", ...result?.meta });

      if (run.terminalState !== "final") {
        const finalText = payloadText(result?.payloads);
        // A completed response is authoritative; keep the stream only when it has no final text.
        if (finalText) {
          run.buffer = finalText;
        }
        const stopReason =
          run.lifecycleStopReason ??
          (typeof result?.meta?.stopReason === "string" ? result.meta.stopReason : undefined);
        this.emitChatTerminal(runId, run, "final", stopReason);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const outcome = findAgentRunTerminalOutcome(error);
      this.projectTerminalOutcome(
        runId,
        run,
        outcome ?? { status: "error", error: errorMessage },
        outcome ? { terminalOutcome: outcome } : {},
      );
    } finally {
      run.textUpdates?.stop();
      run.markQueuedRunReady();
      this.runs.delete(runId);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
