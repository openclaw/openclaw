import { randomUUID } from "node:crypto";
import type { QuestionResolveParams } from "../../packages/gateway-protocol/src/index.js";
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
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
import { ensureContextWindowCacheLoaded } from "../agents/context.js";
import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/active-run-projections.js";
import {
  claimPendingEmbeddedAgentQuestionAnswer,
  queueEmbeddedAgentMessageWithOutcomeAsync,
} from "../agents/embedded-agent-runner/runs.js";
import { QuestionAnswerUnconfirmedError } from "../agents/harness/gateway-question-dispatch.js";
import { resolveThinkingDefault } from "../agents/model-selection.js";
import { resolvePublishedModelCatalogOwner } from "../agents/prepared-model-catalog-owner.js";
import {
  readPreparedModelCatalog,
  withPreparedModelCatalogOwner,
} from "../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import {
  getSubagentSessionListReadSnapshotIdentity,
  prepareOptionalSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { bindEmbeddedSessionRowProjection } from "../agents/tools/embedded-gateway-stub.js";
import { resolveTextCommand } from "../auto-reply/commands-registry.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import { resolveQueueSettingsCore } from "../auto-reply/reply/queue/settings.js";
import {
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_DEBOUNCE_MS,
  DEFAULT_QUEUE_DROP,
} from "../auto-reply/reply/queue/state.js";
import type { QueueSettings } from "../auto-reply/reply/queue/types.js";
import { createDefaultDeps } from "../cli/deps.js";
import { getRuntimeConfig, registerConfigWriteListener } from "../config/config.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionActor,
} from "../config/sessions/session-incognito-binding.js";
import {
  mergeAssistantText,
  resolveAssistantTextInput,
} from "../gateway/agent-event-assistant-text.js";
import { resolveEffectiveChatHistoryMaxChars } from "../gateway/chat-display-projection.js";
import {
  capLiveAssistantText,
  shouldSuppressAssistantEventForLiveChat,
} from "../gateway/live-chat-projector.js";
import { getMaxChatHistoryMessagesBytes } from "../gateway/server-constants.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
} from "../gateway/server-methods/chat-history-budget.js";
import { readChatHistoryPage } from "../gateway/server-methods/chat-history-pages.js";
import { enrichChatHistoryCompactionMarkers } from "../gateway/server-methods/chat-history-response-page.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../gateway/session-row-projection.js";
import { capArrayByJsonBytes } from "../gateway/session-transcript-readers.js";
import { buildGatewaySessionRow } from "../gateway/session-utils-row.js";
import { createGatewaySessionEntryReader } from "../gateway/session-utils-store-lineage.js";
import {
  getSessionDefaults,
  listAgentsForGateway,
  loadSessionEntry,
  loadGatewaySessionEntryReadOnly,
  resolveSessionModelRef,
} from "../gateway/session-utils.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import { type AgentEventPayload, onAgentEvent } from "../infra/agent-events.js";
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
import { logInfo, logWarn } from "../logger.js";
import {
  agentSessionKeysMatchByRequestKey,
  isIncognitoSessionKey,
  normalizeAgentId,
} from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { applyQueueDropPolicy, waitForQueueDebounce } from "../utils/queue-helpers.js";
import {
  assistantChatMessage,
  payloadText,
  projectLocalRunText,
  resolveDeltaPayload,
  resolveTerminalChatState,
} from "./embedded-chat-projection.js";
import { ensureEmbeddedHistoryRuntimePluginsLoaded } from "./embedded-history-runtime.js";
import {
  buildLocalQueuedPrompt,
  timeoutSecondsFromMs,
  waitForLocalRunShutdown,
  waitForQueuedLocalRun,
  type LocalRunState,
  type QueuedSessionRun,
} from "./embedded-local-run.js";
import { EmbeddedPreparedModelRuntimeHost } from "./embedded-prepared-runtime.js";
import { createEmbeddedSessionCommands } from "./embedded-session-commands.js";
import {
  createEmbeddedSessionReader,
  readEmbeddedHistorySessionInfo,
} from "./embedded-session-reader.js";
import {
  withEmbeddedSessionSource,
  type SelectedEmbeddedSession,
} from "./embedded-session-source.js";
import type {
  ChatSendOptions,
  TuiAgentsList,
  TuiApprovalDecision,
  TuiBackend,
  TuiChatSendResult,
  TuiEvent,
  TuiModelChoice,
  TuiImageRequest,
  TuiImageData,
} from "./tui-backend.js";
import { formatTuiErrorMessage } from "./tui-formatters.js";

type LocalPendingMessage = {
  run: LocalRunState;
  messageIndex: number;
  message: string;
};

const silentRuntime = {
  log: (..._args: unknown[]) => undefined,
  error: (..._args: unknown[]) => undefined,
  exit: (code: number): never => {
    throw new Error(`embedded tui runtime exit ${String(code)}`);
  },
};

const embeddedSessionStartupMigrationLog = {
  info: (message: string) => logInfo(message, silentRuntime),
  warn: (message: string) => logWarn(message, silentRuntime),
};

export class EmbeddedTuiBackend implements TuiBackend {
  readonly connection = { url: "local embedded" };

  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  private readonly deps = createDefaultDeps();
  private readonly runs = new Map<string, LocalRunState>();
  private unsubscribe?: () => void;
  private previousRuntimeLog?: typeof defaultRuntime.log;
  private previousRuntimeError?: typeof defaultRuntime.error;
  private seq = 0;
  private stopping = false;
  private readonly pendingLifecycleErrors = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pluginApprovalBroker = new EmbeddedPluginApprovalBroker();
  private readonly scheduler = new GatewayScheduler();
  private readonly questionBroker = new EmbeddedQuestionBroker(this.scheduler);
  private readonly preparedModelRuntime = new EmbeddedPreparedModelRuntimeHost();
  private unsubscribePluginApprovals?: () => void;
  private unsubscribeQuestions?: () => void;
  private unsubscribeConfigWrites?: () => void;
  private sessionProjection?: Promise<SessionRowProjection>;
  private unbindSessionProjection?: () => void;
  // Store methods await migration and the shared resident session rows.
  private ready: Promise<void> = Promise.resolve();
  private readonly sessionReader = createEmbeddedSessionReader({
    ready: () => this.ready,
    projection: () => this.sessionProjection,
  });
  private readonly sessionCommands = createEmbeddedSessionCommands({
    ready: () => this.ready,
    modelRuntimeReady: () => this.preparedModelRuntime.waitUntilReady(),
  });

  start() {
    if (this.unsubscribe) {
      return;
    }
    this.stopping = false;
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
    this.unsubscribePluginApprovals = this.pluginApprovalBroker.subscribe((event) => {
      this.emit(event.event, event.payload);
    });
    setEmbeddedQuestionBroker(this.questionBroker);
    this.unsubscribeQuestions = this.questionBroker.subscribe((event) => {
      this.emit(event.event, event.payload);
    });
    const config = getRuntimeConfig();
    // Local mode shares the Gateway's session-store readiness checks.
    this.sessionProjection = (async () => {
      const { runSessionStartupMigration } =
        await import("../config/sessions/startup-migration.js");
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
    this.stopping = true;
    this.scheduler.beginClose();
    clearEmbeddedPluginApprovalBroker(this.pluginApprovalBroker);
    this.unsubscribePluginApprovals?.();
    this.unsubscribePluginApprovals = undefined;
    clearEmbeddedQuestionBroker(this.questionBroker);
    this.unsubscribeQuestions?.();
    this.unsubscribeQuestions = undefined;
    const maintenancePromises: Promise<void>[] = [];
    const boundRunPromises: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      if (run.boundSession && run.promise) {
        boundRunPromises.push(run.promise);
      }
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
    await Promise.allSettled(boundRunPromises);
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
    for (const run of this.runs.values()) {
      run.controller.abort();
    }
    this.runs.clear();
    defaultRuntime.log = this.previousRuntimeLog ?? defaultRuntime.log;
    defaultRuntime.error = this.previousRuntimeError ?? defaultRuntime.error;
    this.previousRuntimeLog = undefined;
    this.previousRuntimeError = undefined;
    setEmbeddedMode(false);
    await this.preparedModelRuntime.waitUntilReady();
  }

  async sendChat(opts: ChatSendOptions): Promise<TuiChatSendResult> {
    return withEmbeddedSessionSource(opts.sessionKey, opts.agentId, (selected, assertSelected) =>
      this.sendChatFromSource(opts, selected, assertSelected),
    );
  }

  private async sendChatFromSource(
    opts: Parameters<EmbeddedTuiBackend["sendChat"]>[0],
    selected: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) {
    await this.ready;
    await this.preparedModelRuntime.waitUntilReady();
    assertSelected();
    if (this.stopping) {
      throw new Error("Local backend is stopping");
    }
    const runId = opts.runId ?? randomUUID();
    const sideCommand = /^\/(?:btw|side)(?::|\s)+(.*)$/i.exec(opts.message.trim());
    const question = sideCommand?.[1]?.trim() || undefined;
    const isQueueCommand = resolveTextCommand(opts.message)?.command.key === "queue";
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
    const sessionRun = this.findQueuedSessionRunPromise(runScope);
    const stopCommand = sessionRun !== undefined && isAbortRequestText(opts.message);
    const queuedAfter = question || stopCommand || isQueueCommand ? undefined : sessionRun;
    if (stopCommand) {
      this.abortSessionRuns(runScope);
      return { runId };
    }
    let pendingQueue: LocalRunState["pendingQueue"];
    if (queuedAfter) {
      const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
      const { cfg, canonicalKey, entry } =
        selected ?? loadSessionEntry(opts.sessionKey, loadOptions);
      assertSelected();
      const activeSessionId = resolveActiveEmbeddedRunSessionId(canonicalKey);
      if (activeSessionId) {
        const claimed = await claimPendingEmbeddedAgentQuestionAnswer(
          activeSessionId,
          opts.message,
        );
        assertSelected();
        if (claimed) {
          return claimed;
        }
      }
      let queueSettings = resolveQueueSettingsCore({
        cfg,
        channel: INTERNAL_MESSAGE_CHANNEL,
        sessionEntry: entry,
      });
      if (queueSettings.mode === "steer") {
        if (activeSessionId) {
          const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
            activeSessionId,
            opts.message,
            {
              steeringMode: "all",
              debounceMs: queueSettings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS,
              isInboundUserMessage: true,
            },
          ).catch((error: unknown) => {
            if (selected || error instanceof QuestionAnswerUnconfirmedError) {
              throw error;
            }
            return undefined;
          });
          assertSelected();
          if (outcome?.queued) {
            return { runId: queuedAfter.runId };
          }
        }
        queueSettings = { ...queueSettings, mode: "followup" };
      }
      if (queueSettings.mode === "interrupt") {
        this.abortSessionRuns(runScope);
      } else {
        const queued = this.enqueuePendingLocalMessage({
          runScope,
          message: opts.message,
          settings: queueSettings,
          fallbackRunId: queuedAfter.runId,
        });
        if (queued.kind === "handled") {
          return { runId: queued.runId };
        }
        pendingQueue = queued.queue;
      }
    }
    const controller = new AbortController();
    const queuedRunReadiness = createDeferredCore();
    const run: LocalRunState = {
      sessionKey: opts.sessionKey,
      agentId,
      controller,
      buffer: "",
      managedMediaUrls: new Set(),
      question,
      finishing: false,
      lifecycleEnded: false,
      registered: false,
      boundSession: selected !== undefined,
      incognitoIncarnation: this.currentIncognitoIncarnation(runScope),
      ...(pendingQueue ? { pendingQueue } : {}),
      ...(queuedAfter ? { queuedAfter } : {}),
      queuedRunReady: queuedRunReadiness.promise,
      markQueuedRunReady: queuedRunReadiness.resolve,
    };
    this.runs.set(runId, run);

    const runPromise = (run.promise = this.runTurn({
      runId,
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
      message: opts.message,
      thinking: opts.thinking,
      deliver: opts.deliver,
      timeoutMs: opts.timeoutMs,
      controller,
      queuedAfter,
    }));

    if (isQueueCommand) {
      // Queue directives are control-plane mutations. Complete them before
      // admitting another local prompt so later sends cannot overtake the new mode.
      await runPromise;
    }

    return { runId };
  }

  async abortChat(opts: { sessionKey: string; agentId?: string; runId?: string }) {
    const incarnation = this.currentIncognitoIncarnation(opts);
    const runIds: string[] = [];
    const candidates = opts.runId ? [[opts.runId, this.runs.get(opts.runId)] as const] : this.runs;
    for (const [runId, run] of candidates) {
      if (
        !run ||
        run.incognitoIncarnation !== incarnation ||
        (!opts.runId && run.question) ||
        run.sessionKey !== opts.sessionKey
      ) {
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
    const source = captureIncognitoSessionSource({
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
    });
    const claim =
      source && !("kind" in source)
        ? source.actor.sessions.captureCurrent(opts.sessionKey)
        : undefined;
    const load = async () => {
      const { loadEmbeddedImage } = await import("./embedded-image-loader.js");
      claim?.assertCurrent();
      return loadEmbeddedImage(opts);
    };
    return source && !("kind" in source)
      ? withIncognitoSessionActor(source.actor, load, source.admissionSignal)
      : load();
  }

  async loadHistory(opts: { sessionKey: string; agentId?: string; limit?: number }) {
    return withEmbeddedSessionSource(opts.sessionKey, opts.agentId, (bound, assertSelected) =>
      this.loadHistoryFromSource(opts, bound, assertSelected),
    );
  }

  private async loadHistoryFromSource(
    opts: Parameters<EmbeddedTuiBackend["loadHistory"]>[0],
    bound: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) {
    const incognitoIncarnation = this.currentIncognitoIncarnation(opts);
    await this.ready;
    await this.preparedModelRuntime.waitUntilReady();
    if (!bound && !getSubagentSessionListReadSnapshotIdentity()) {
      await prepareOptionalSubagentSessionListReadCache();
    }
    const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
    const selected =
      bound ??
      loadGatewaySessionEntryReadOnly(opts.sessionKey, {
        ...loadOptions,
        includeStoreChildEntries: true,
      });
    const {
      cfg,
      agentId: sessionAgentId,
      storePath,
      store,
      readSource,
      entry,
      canonicalKey,
    } = selected;
    assertSelected();
    const sessionId = entry?.sessionId;
    const runtimePluginsPrewarm = ensureEmbeddedHistoryRuntimePluginsLoaded({
      cfg,
      sessionAgentId,
    });
    const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const max = Math.min(
      CHAT_HISTORY_MAX_ENTRIES,
      typeof opts.limit === "number" ? opts.limit : 200,
    );
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
        run.incognitoIncarnation === incognitoIncarnation &&
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
    const [privateAcpMeta] = privateEntry
      ? await readAcpSessionMetaForEntries({
          cfg,
          entries: [{ agentId: sessionAgentId, sessionKey: canonicalKey, entry }],
        })
      : [];
    const sessionInfo = privateEntry
      ? buildGatewaySessionRow({
          cfg,
          storePath,
          store,
          key: canonicalKey,
          entry,
          preparedAcpMeta: privateAcpMeta ?? null,
          agentId: sessionAgentId,
          modelSource: { entry, readSourceEntry: createGatewaySessionEntryReader(selected) },
          lightweightListRow: true,
          skipTranscriptUsageFallback: true,
        })
      : entry && projection
        ? await readEmbeddedHistorySessionInfo(projection, target, {
            sessionId,
            lifecycleRevision: entry.lifecycleRevision,
          })
        : undefined;
    const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
    if (sessionInfo) {
      sessionInfo.thinkingLevel = thinkingLevel;
      sessionInfo.verboseLevel = verboseLevel;
    }

    assertSelected();
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

  patchSession = this.sessionCommands.patchSession;
  resetSession = this.sessionCommands.resetSession;
  createSession = this.sessionCommands.createSession;

  private async runBtwTurn(params: {
    runId: string;
    sessionKey: string;
    agentId?: string;
    question: string;
    timeoutMs?: number;
    controller: AbortController;
  }) {
    return withEmbeddedSessionSource(
      params.sessionKey,
      params.agentId,
      (selected, assertSelected) => this.runBtwTurnFromSource(params, selected, assertSelected),
    );
  }

  private async runBtwTurnFromSource(
    params: Parameters<EmbeddedTuiBackend["runBtwTurn"]>[0],
    selected: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) {
    const loadOptions = params.agentId ? { agentId: params.agentId } : undefined;
    const {
      cfg,
      agentId: sessionAgentId,
      canonicalKey,
      storePath,
      store,
      entry,
    } = selected ?? loadSessionEntry(params.sessionKey, loadOptions);
    if (!entry?.sessionId) {
      throw new Error("/btw requires an active session with existing context.");
    }
    const resolvedModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const timeoutSeconds = timeoutSecondsFromMs(params.timeoutMs);
    const { runBtwSideQuestion } = await import("../agents/btw.js");
    assertSelected();
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
    });
    assertSelected();
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

  runGoalCommand = this.sessionCommands.runGoalCommand;
  runUsageCostCommand = this.sessionCommands.runUsageCostCommand;

  private enqueuePendingLocalMessage(params: {
    runScope: { sessionKey: string; agentId?: string };
    message: string;
    settings: QueueSettings;
    fallbackRunId: string;
  }):
    | { kind: "handled"; runId: string }
    | { kind: "enqueue"; queue: NonNullable<LocalRunState["pendingQueue"]> } {
    const pendingMessages: LocalPendingMessage[] = [];
    for (const run of this.runs.values()) {
      if (this.isSameRunScope(run, params.runScope) && run.pendingQueue) {
        run.pendingQueue.messages.forEach((message, messageIndex) => {
          pendingMessages.push({ run, messageIndex, message });
        });
      }
    }
    const overflowQueue = {
      items: [...pendingMessages],
      cap: params.settings.cap ?? DEFAULT_QUEUE_CAP,
      dropPolicy: params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
      droppedCount: 0,
      summaryLines: [] as string[],
    };
    const admitted = applyQueueDropPolicy({
      queue: overflowQueue,
      summarize: (item) => item.message,
    });
    if (!admitted) {
      return { kind: "handled", runId: params.fallbackRunId };
    }

    const retained = new Set(overflowQueue.items);
    const droppedByRun = new Map<LocalRunState, number[]>();
    for (const dropped of pendingMessages) {
      if (retained.has(dropped)) {
        continue;
      }
      const indices = droppedByRun.get(dropped.run) ?? [];
      indices.push(dropped.messageIndex);
      droppedByRun.set(dropped.run, indices);
    }
    const inheritedSummaryLines: string[] = [];
    for (const [run, indices] of droppedByRun) {
      for (const index of indices.toSorted((a, b) => b - a)) {
        run.pendingQueue?.messages.splice(index, 1);
      }
      if (run.pendingQueue?.messages.length === 0) {
        inheritedSummaryLines.push(...run.pendingQueue.summaryLines);
        overflowQueue.droppedCount += run.pendingQueue.droppedCount;
        run.controller.abort();
      }
    }
    overflowQueue.summaryLines.unshift(...inheritedSummaryLines);
    if (overflowQueue.summaryLines.length > overflowQueue.cap) {
      overflowQueue.summaryLines.splice(0, overflowQueue.summaryLines.length - overflowQueue.cap);
    }

    const enqueuedAt = Date.now();
    for (const run of this.runs.values()) {
      if (!this.isSameRunScope(run, params.runScope) || !run.pendingQueue) {
        continue;
      }
      run.pendingQueue.lastEnqueuedAt = enqueuedAt;
      run.pendingQueue.debounceMs = params.settings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS;
    }

    if (params.settings.mode === "collect") {
      const target = [...this.runs.entries()].findLast(
        ([, run]) => this.isSameRunScope(run, params.runScope) && run.pendingQueue,
      );
      const targetQueue = target?.[1].pendingQueue;
      if (target && targetQueue?.mode === "collect" && !target[1].controller.signal.aborted) {
        const [targetRunId] = target;
        targetQueue.messages.push(params.message);
        targetQueue.dropPolicy = params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP;
        targetQueue.droppedCount += overflowQueue.droppedCount;
        targetQueue.summaryLines.push(...overflowQueue.summaryLines);
        return { kind: "handled", runId: targetRunId };
      }
    }

    return {
      kind: "enqueue",
      queue: {
        mode: params.settings.mode === "collect" ? "collect" : "followup",
        messages: [params.message],
        debounceMs: params.settings.debounceMs ?? DEFAULT_QUEUE_DEBOUNCE_MS,
        lastEnqueuedAt: enqueuedAt,
        dropPolicy: params.settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
        droppedCount: overflowQueue.droppedCount,
        summaryLines: overflowQueue.summaryLines,
      },
    };
  }

  private findQueuedSessionRunPromise(params: {
    sessionKey: string;
    agentId?: string;
  }): QueuedSessionRun | undefined {
    let queuedAfter: QueuedSessionRun | undefined;
    for (const [runId, run] of this.runs) {
      if (this.isSameRunScope(run, params) && !run.question && run.promise) {
        queuedAfter = { runId, run, promise: run.promise };
      }
    }
    return queuedAfter;
  }

  private abortSessionRuns(params: { sessionKey: string; agentId?: string }) {
    for (const run of this.runs.values()) {
      if (this.isSameRunScope(run, params) && !run.question && this.isAbortableRun(run)) {
        run.controller.abort();
      }
    }
  }

  private currentIncognitoIncarnation(params: { sessionKey: string; agentId?: string }) {
    const source = captureIncognitoSessionSource(params);
    return source && !("kind" in source) ? source.actor.identity.incarnation : undefined;
  }

  private isSameRunScope(run: LocalRunState, params: { sessionKey: string; agentId?: string }) {
    return (
      run.incognitoIncarnation === this.currentIncognitoIncarnation(params) &&
      run.sessionKey === params.sessionKey &&
      (params.sessionKey !== "global" || run.agentId === params.agentId)
    );
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

  private handleAgentEvent(evt: AgentEventPayload) {
    const run = this.runs.get(evt.runId);
    if (!run) {
      return;
    }
    try {
      run.assertSessionCurrent?.();
    } catch (error) {
      run.controller.abort();
      this.emitChatTerminal(evt.runId, run, "error", formatTuiErrorMessage(error));
      return;
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : "";
    if (evt.stream !== "lifecycle" || lifecyclePhase !== "error") {
      this.clearPendingLifecycleError(evt.runId);
    }

    if (evt.stream !== "assistant") {
      this.ensureRunRegistered(evt.runId, run);
    }

    this.emitRun("agent", evt.runId, run, {
      stream: evt.stream,
      data: evt.data,
    });

    if (evt.stream === "assistant" || (evt.stream === "tool" && evt.data?.phase === "start")) {
      run.toolErrorSummary = undefined;
    } else if (evt.stream === "tool" && evt.data?.phase === "result") {
      run.toolErrorSummary = readToolValidationErrorSummary(evt.data.toolErrorSummary);
    }

    const assistantLiveChatInput =
      evt.stream === "assistant" ? resolveAssistantTextInput(evt.data) : undefined;
    if (
      assistantLiveChatInput &&
      !run.question &&
      !shouldSuppressAssistantEventForLiveChat(evt.data)
    ) {
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
      this.emitChatDelta(evt.runId, run);
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

  private async runTurn(params: {
    runId: string;
    sessionKey: string;
    agentId?: string;
    message: string;
    thinking?: string;
    deliver?: boolean;
    timeoutMs?: number;
    controller: AbortController;
    queuedAfter?: QueuedSessionRun;
  }) {
    try {
      await withEmbeddedSessionSource(
        params.sessionKey,
        params.agentId,
        (selected, assertSelected) => this.runTurnFromSource(params, selected, assertSelected),
      );
    } catch (error) {
      const run = this.runs.get(params.runId);
      if (run) {
        this.emitChatTerminal(params.runId, run, "error", formatTuiErrorMessage(error));
        run.markQueuedRunReady();
        this.runs.delete(params.runId);
      }
    }
  }

  private async runTurnFromSource(
    params: Parameters<EmbeddedTuiBackend["runTurn"]>[0],
    selected: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) {
    try {
      const source = captureIncognitoSessionSource(params);
      const creatingActor =
        selected && !selected.entry && source && !("kind" in source) ? source : undefined;
      let assertCreatedCurrent: (() => void) | undefined;
      const assertRunCurrent = creatingActor
        ? () => {
            creatingActor.admissionSignal?.throwIfAborted();
            creatingActor.actor.assertReadable();
            assertCreatedCurrent?.();
          }
        : assertSelected;
      const capturedRun = this.runs.get(params.runId);
      if (capturedRun && selected) {
        capturedRun.assertSessionCurrent = assertRunCurrent;
      }
      const recheckPreparedRuntimeAtAdmission = params.queuedAfter !== undefined;
      if (params.queuedAfter) {
        try {
          await Promise.race([
            waitForQueuedLocalRun(params.queuedAfter, params.runId),
            waitForAbortSignal(params.controller.signal),
          ]);
        } catch (error) {
          const run = this.runs.get(params.runId);
          if (run) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.emitChatTerminal(
              params.runId,
              run,
              "error",
              `previous run did not finish cleanly: ${errorMessage}`,
            );
          }
          return;
        }
        if (params.controller.signal.aborted) {
          const run = this.runs.get(params.runId);
          if (run) {
            this.emitChatTerminal(params.runId, run, "aborted");
          }
          return;
        }
      }
      const activeRun = this.runs.get(params.runId);
      delete activeRun?.queuedAfter;
      let message = params.message;
      if (activeRun?.pendingQueue) {
        await waitForQueueDebounce(activeRun.pendingQueue, params.controller.signal);
        if (params.controller.signal.aborted) {
          this.emitChatTerminal(params.runId, activeRun, "aborted");
          return;
        }
        message = buildLocalQueuedPrompt(activeRun.pendingQueue);
        delete activeRun.pendingQueue;
      }
      if (recheckPreparedRuntimeAtAdmission) {
        // A turn may have queued behind another local run while a config write published a new
        // generation. Recheck at actual model admission so it cannot use stale facts.
        await this.preparedModelRuntime.waitUntilReady();
        if (params.controller.signal.aborted) {
          if (activeRun) {
            this.emitChatTerminal(params.runId, activeRun, "aborted");
          }
          return;
        }
      }
      if (activeRun?.question) {
        const result = await this.runBtwTurn({
          runId: params.runId,
          sessionKey: params.sessionKey,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          question: activeRun.question,
          timeoutMs: params.timeoutMs,
          controller: params.controller,
        });
        const run = this.runs.get(params.runId);
        if (!run) {
          return;
        }
        if (params.controller.signal.aborted) {
          this.emitChatTerminal(params.runId, run, "aborted");
          return;
        }
        assertSelected();
        this.emit("chat.side_result", {
          kind: "btw",
          runId: params.runId,
          sessionKey: result.sessionKey,
          agentId: run.agentId,
          question: run.question,
          text: result.text,
          ...(result.isError ? { isError: true } : {}),
        });
        this.emitChatTerminal(params.runId, run, "final");
        return;
      }
      const loadOptions = params.agentId ? { agentId: params.agentId } : undefined;
      const { agentId, canonicalKey, entry } =
        selected ?? loadSessionEntry(params.sessionKey, loadOptions);
      assertSelected();
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
          thinking: params.thinking,
          deliver: params.deliver,
          channel: INTERNAL_MESSAGE_CHANNEL,
          runContext: {
            messageChannel: INTERNAL_MESSAGE_CHANNEL,
          },
          timeout: timeoutSecondsFromMs(params.timeoutMs),
          runId: params.runId,
          abortSignal: params.controller.signal,
          allowModelOverride: false,
          ...(creatingActor && {
            onExecutionStarted: () => {
              assertRunCurrent();
              if (!assertCreatedCurrent) {
                if (!creatingActor.actor.sessions.readSharing(canonicalKey)?.entry) {
                  throw new Error("Local session was not created before execution");
                }
                // Canonical creation replaces the initial absence; retain its first generation.
                const claim = creatingActor.actor.sessions.captureCurrent(canonicalKey);
                assertCreatedCurrent = () => claim.assertCurrent();
              }
              assertRunCurrent();
            },
          }),
        },
        silentRuntime,
        this.deps,
      );
      assertRunCurrent();
      const run = this.runs.get(params.runId);
      if (!run) {
        return;
      }
      if (
        this.projectTerminalOutcome(params.runId, run, result?.meta ?? {}, {
          visibleText: payloadText(result?.payloads),
        })
      ) {
        return;
      }
      run.lifecycleYielded ||= isAgentLifecycleYieldedWaiting({
        phase: "end",
        ...result?.meta,
      });

      if (run.terminalState !== "final") {
        const finalText = payloadText(result?.payloads);
        // A completed response is authoritative; keep the stream only when it has no final text.
        if (finalText) {
          run.buffer = finalText;
        }
        const stopReason =
          run.lifecycleStopReason ??
          (typeof result?.meta?.stopReason === "string" ? result.meta.stopReason : undefined);
        this.emitChatTerminal(params.runId, run, "final", stopReason);
      }
    } catch (error) {
      const run = this.runs.get(params.runId);
      if (!run) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const outcome = findAgentRunTerminalOutcome(error);
      this.projectTerminalOutcome(
        params.runId,
        run,
        outcome ?? { status: "error", error: errorMessage },
        outcome ? { terminalOutcome: outcome } : {},
      );
    } finally {
      this.runs.get(params.runId)?.markQueuedRunReady();
      this.runs.delete(params.runId);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
