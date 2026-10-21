import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { captureSessionMcpRuntimeRetirement } from "../agents/agent-bundle-mcp-manager-api.js";
import { prepareAgentRunTerminalReply } from "../agents/agent-run-terminal-reply.js";
import {
  listAgentIds,
  resolveAgentEntry,
  tryResolveAmbientOwnerAgentId,
} from "../agents/agent-scope-config.js";
import { abortAndDrainEmbeddedAgentRunByRunId } from "../agents/embedded-agent-runner/runs.js";
import { abortAndDrainEmbeddedAgentRun } from "../agents/embedded-agent.js";
import { loadPreparedInboundPluginRegistry } from "../agents/prepared-model-runtime.inbound-registry.js";
import type { CliDeps } from "../cli/deps.types.js";
import { DEFAULT_CRON_ENABLED } from "../config/cron-limits.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveSystemMainSessionTarget,
} from "../config/sessions.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listKnownSessionStoreAgentIdsAsync } from "../config/sessions/targets-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import { redactCronCommandSummaryForExternalDelivery } from "../cron/command-output-summary.js";
import { runCronCommandJob } from "../cron/command-runner.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { resolveCronJobBoundSessionKeys } from "../cron/job-session-bindings.js";
import { cronScriptFailureMetadata } from "../cron/script-failure.js";
import { CronService, type CronEvent } from "../cron/service.js";
import { resolveCronSessionTargetSessionKey } from "../cron/session-target.js";
import { createCronScriptRuntime } from "../cron/trigger-script.js";
import type { CronJob } from "../cron/types.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveMainScopedEventSessionKey } from "../infra/event-session-routing.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  resolveHeartbeatForWake,
  resolveHeartbeatTimeoutOverrideSeconds,
  sanitizeCronHeartbeatOverride,
} from "../infra/heartbeat-config.js";
import {
  requestHeartbeat,
  requestHeartbeatAndWait,
  type HeartbeatWakeRequest,
} from "../infra/heartbeat-wake.js";
import { mergeSsrFPolicies } from "../infra/net/ssrf.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import { getChildLogger, getResolvedLoggerSettings, toPinoLikeLogger } from "../logging.js";
import type {
  PluginHookCronChangedEvent,
  PluginHookGatewayCronService,
  PluginHookGatewayContext,
} from "../plugins/hook-gateway.types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getGatewaySuspendAdmissionPhase,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  normalizeAgentId,
  resolveEventSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { truncateUtf16WithEllipsis } from "../shared/text-truncate.js";
import {
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import {
  createCronExitWatchers,
  type CronExitWatcherHandlers,
  type CronExitWatchers,
} from "./cron-exit-watchers.js";
import { createCronStreamWatchers, resolveStreamStopReason } from "./cron-stream-watchers.js";
import {
  createScheduledGatewayRunner,
  fenceScheduledGatewayContextResolver,
} from "./scheduled-run-gateway-context.js";
import { finalizeCronCompletionAnnouncement, pickDefined } from "./server-cron-completion.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import {
  bindCronStreamRemoval,
  bindCronStreamUpdate,
  drainGatewayCron,
  withObservedCronStreamState,
} from "./server-cron-drain.js";
import {
  enqueueCronSystemEvent,
  fireOnExitJob,
  fireStreamJob,
  formatOnExitRunSummary,
  resolveGatewayCronOriginDeliveryContext,
  runGatewayCronSessionEvent,
} from "./server-cron-event-dispatch.js";
import { describeCronInferenceMigration } from "./server-cron-inference.js";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronWebhook,
  sendGatewayCronFailureAlert,
  createGatewayCronFailureRepair,
} from "./server-cron-notifications.js";
import { toPluginCronChangedEvent } from "./server-cron-plugin-job.js";
import {
  createGatewayCronSystemJobReconciler,
  type GatewaySystemJobReconciliationResult,
} from "./server-cron-system-jobs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  invalidateSessionAutomationIndex,
  registerSessionAutomationSource,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

export type GatewayCronState = {
  cron: GatewayCronServiceContract;
  storePath: string;
  cronEnabled: boolean;
  prepareExitWatcherHandoff?: () => Promise<GatewayCronExitWatcherHandoff | undefined>;
  // The lazy proxy must preserve system-job reconciliation on the serving config.
  reconcileExitWatchers: () => Promise<void>;
  reconcileStreamWatchers: () => Promise<void>;
  stopStreamWatchers: () => Promise<void>;
  reconcileSystemJobs: () => Promise<GatewaySystemJobReconciliationResult>;
};

export type GatewayCronExitWatcherHandoff = {
  current: () => CronExitWatchers;
  adopt: (watchers: CronExitWatchers) => Promise<void> | void;
  stopOwner: () => Promise<void>;
};

export function buildGatewayCronService(params: {
  scheduler: GatewayScheduler;
  storePath: string;
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  env?: NodeJS.ProcessEnv;
  resolveGatewayContext?: () => GatewayRequestContext | undefined;
  resolvePluginRegistry?: () => PluginRegistry | undefined;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const cronServiceLogger = toPinoLikeLogger(cronLogger, getResolvedLoggerSettings().level);
  const scheduledGatewayContextResolver = fenceScheduledGatewayContextResolver(
    params.resolveGatewayContext,
  );
  const runSchedulerOwned = createScheduledGatewayRunner(
    scheduledGatewayContextResolver,
    params.resolvePluginRegistry,
  );
  const env = params.env ?? process.env;
  const storePath = params.storePath;
  const cronEnabled =
    env.OPENCLAW_SKIP_CRON !== "1" && (params.cfg.cron?.enabled ?? DEFAULT_CRON_ENABLED);
  // Resolve once per cron service snapshot so every webhook route shares the
  // same explicit opt-in while omitted config keeps the guard strict.
  const webhookSsrfPolicy = mergeSsrFPolicies(params.cfg.cron?.webhookSsrfPolicy);

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = getRuntimeConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const defaultAgentId = tryResolveAmbientOwnerAgentId(runtimeConfig);
    if (
      normalized !== undefined &&
      normalized !== defaultAgentId &&
      !resolveAgentEntry(runtimeConfig, normalized)
    ) {
      throw new Error(`cron job agent is unavailable: ${normalized}`);
    }
    const agentId = resolveCronJobEffectiveAgentId(
      normalized ? { agentId: normalized } : {},
      defaultAgentId,
    );
    assertAgentDatabaseAdmitted(agentId, { env });
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (paramsValue: {
    runtimeConfig: OpenClawConfig;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = paramsValue.requestedSessionKey?.trim();
    const candidate = toAgentStoreSessionKey({
      agentId: paramsValue.agentId,
      requestKey: requested,
      mainKey: paramsValue.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: paramsValue.runtimeConfig,
      agentId: paramsValue.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(paramsValue.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: paramsValue.runtimeConfig,
          agentId: paramsValue.agentId,
        });
      }
    }
    return (
      resolveMainScopedEventSessionKey({
        cfg: paramsValue.runtimeConfig,
        sessionKey: canonical,
        agentId: paramsValue.agentId,
      }) ?? canonical
    );
  };

  const resolveCronTarget = (opts?: {
    agentId?: string | null;
    sessionKey?: string | null;
    preserveUntargeted?: boolean;
  }) => {
    const requestedAgentId =
      typeof opts?.agentId === "string" && opts.agentId.trim()
        ? normalizeAgentId(opts.agentId)
        : undefined;
    const requestedSessionKey =
      typeof opts?.sessionKey === "string" && opts.sessionKey.trim() ? opts.sessionKey : undefined;
    if (opts?.preserveUntargeted && !requestedAgentId && !requestedSessionKey) {
      return { runtimeConfig: getRuntimeConfig(), agentId: undefined, sessionKey: undefined };
    }
    if (!requestedAgentId && !requestedSessionKey) {
      const runtimeConfig = getRuntimeConfig();
      return { runtimeConfig, ...resolveSystemMainSessionTarget(runtimeConfig) };
    }

    // Derive from canonical agent-prefixed keys only. Relative keys intentionally
    // fall through to the configured default instead of hardcoding "main".
    const derivedAgentId =
      requestedSessionKey && parseAgentSessionKey(requestedSessionKey)
        ? resolveAgentIdFromSessionKey(requestedSessionKey)
        : undefined;
    const { agentId, cfg: runtimeConfig } = resolveCronAgent(requestedAgentId ?? derivedAgentId);
    const resolvedSessionKey = resolveCronSessionKey({
      runtimeConfig,
      agentId,
      requestedSessionKey,
    });
    const sessionKey =
      resolvedSessionKey && runtimeConfig.session?.scope === "global"
        ? resolveEventSessionKey(
            resolvedSessionKey,
            runtimeConfig.session?.mainKey,
            runtimeConfig.session?.scope,
          )
        : resolvedSessionKey;
    return { runtimeConfig, agentId, sessionKey };
  };

  const resolveCronHeartbeatWake = (opts: HeartbeatWakeRequest): HeartbeatWakeRequest => {
    const { agentId, sessionKey } = resolveCronTarget({
      ...opts,
      preserveUntargeted: opts.source !== "manual",
    });
    // Untargeted monitor ticks resolve their configured session in the runner.
    const useConfiguredSession = opts.source === "interval" && !opts.sessionKey?.trim();
    return {
      source: opts.source,
      intent: opts.intent,
      reason: opts.reason,
      agentId,
      sessionKey: useConfiguredSession ? undefined : sessionKey,
      heartbeat: sanitizeCronHeartbeatOverride(opts.heartbeat),
      ...(opts.scheduledEveryMs !== undefined ? { scheduledEveryMs: opts.scheduledEveryMs } : {}),
      ...(opts.tasks?.length ? { tasks: opts.tasks } : {}),
    };
  };

  const defaultAgentId = tryResolveAmbientOwnerAgentId(params.cfg);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: agentId ?? resolveSessionStoreCompatibilityAgentId(getRuntimeConfig()),
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const cronTriggersEnabled = params.cfg.cron?.triggers?.enabled !== false;
  const scriptRuntime = cronTriggersEnabled
    ? createCronScriptRuntime({
        config: params.cfg,
        loadPluginRegistry: loadPreparedInboundPluginRegistry,
        resolveGatewayContext: scheduledGatewayContextResolver,
      })
    : undefined;

  const runCronChangedHook = (evt: PluginHookCronChangedEvent) => {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("cron_changed")) {
      return;
    }
    const hookCtx: PluginHookGatewayContext = {
      config: getRuntimeConfig(),
      getCron: () => cron as PluginHookGatewayCronService,
    };
    // Hook execution is detached from the cron mutation/tick that emitted it.
    // Keep the whole plugin callback visible until its user-state effects settle.
    void runInDetachedAsyncContext(() =>
      runWithGatewayIndependentRootWorkAdmission(async () => {
        await runSchedulerOwned(() => hookRunner.runCronChanged(evt, hookCtx));
      }, "cron:changed-hook").catch((err: unknown) => {
        cronLogger.warn(
          { err: formatErrorMessage(err), jobId: evt.jobId },
          "cron_changed hook failed",
        );
      }),
    );
  };

  // Built after cron so watcher exit callbacks can call back into the service.
  let exitWatchers: CronExitWatchers | undefined;
  let exitWatcherReconciliations = 0;
  let streamWatcherReconciliations = 0;
  const terminalExitCompletionTokens = new Map<
    string,
    Parameters<CronService["updateWithPrecondition"]>[2]
  >();
  let exitWatcherMutationRevision = 0;
  let exitWatchersStopped = false;
  let exitWatcherHandoffReady: { result: Deferred<boolean>; settled: boolean } | undefined;
  const settleExitWatcherHandoff = (ready: boolean, handoff = exitWatcherHandoffReady) => {
    if (!handoff) {
      return;
    }
    handoff.settled = true;
    handoff.result.resolve(ready);
    if (ready && exitWatcherHandoffReady === handoff) {
      exitWatcherHandoffReady = undefined;
    }
  };
  // Bumped when a direct watcher route begins; fences reconcile's async list
  // snapshot against mutations that commit inside the list await.
  let streamWatcherMutationRevision = 0;
  let streamWatchersStopped = false;
  let sandboxStreams:
    | Promise<ReturnType<typeof import("./cron-stream-sandbox.js").createCronStreamSandboxExecutor>>
    | undefined;
  const getSandboxStreams = () =>
    (sandboxStreams ??= import("./cron-stream-sandbox.js").then(
      ({ createCronStreamSandboxExecutor }) =>
        createCronStreamSandboxExecutor({
          scheduler: params.scheduler,
          storePath,
          getRuntimeConfig,
          getJob: (id) => cron.getJob(id),
          assertCurrent: () => {
            if (streamWatchersStopped || !cronEnabled || !cronTriggersEnabled) {
              throw new Error("Sandbox stream execution is no longer enabled.");
            }
          },
        }),
    ));
  const reconcileExitWatchers = async () => {
    const revision = ++exitWatcherMutationRevision;
    exitWatcherReconciliations += 1;
    try {
      if (!exitWatchers || exitWatchersStopped) {
        return;
      }
      const jobs = await cron.list({ includeDisabled: true });
      if (exitWatchersStopped || revision !== exitWatcherMutationRevision) {
        return;
      }
      if (cronEnabled) {
        exitWatchers.reconcile(jobs);
      } else {
        await exitWatchers.cancelAll();
      }
    } catch (err) {
      cronLogger.warn({ err: String(err) }, "cron-exit: reconcile failed");
    } finally {
      exitWatcherReconciliations -= 1;
    }
  };
  const reconcileStreamWatchers = async () => {
    streamWatcherReconciliations += 1;
    try {
      const watchers = streamWatchers;
      if (!watchers || streamWatchersStopped) {
        return;
      }
      const revision = streamWatcherMutationRevision;
      const jobs = await cron.list({ includeDisabled: true });
      // Mutations route their own exact job; do not let an older sweep retire it.
      if (streamWatchersStopped || revision !== streamWatcherMutationRevision) {
        return;
      }
      await watchers.reconcile(jobs, cronEnabled && cronTriggersEnabled, cronTriggersEnabled);
    } catch (err) {
      cronLogger.warn({ err: String(err) }, "cron-stream: reconcile failed");
    } finally {
      streamWatcherReconciliations -= 1;
    }
  };

  const routeStreamWatcherMutation = async (
    jobId: string,
    job: CronJob | undefined,
    action: "added" | "updated" | "removed" | "finished",
  ) => {
    const watchers = streamWatchers;
    if (!watchers || streamWatchersStopped) {
      return;
    }
    streamWatcherMutationRevision += 1;
    streamWatcherReconciliations += 1;
    try {
      if (action === "removed") {
        await watchers.stop(jobId, "removed");
        return;
      }
      if (
        job?.schedule.kind === "stream" &&
        job.enabled &&
        !job.state.streamRestartExhausted &&
        cronEnabled &&
        cronTriggersEnabled
      ) {
        await watchers.start(job);
        return;
      }
      const reason = resolveStreamStopReason({
        triggersEnabled: cronTriggersEnabled,
        cronEnabled,
        restartExhausted: job?.state.streamRestartExhausted === true,
        isStream: job?.schedule.kind === "stream",
      });
      await watchers.stop(jobId, reason, job);
    } finally {
      streamWatcherReconciliations -= 1;
    }
  };

  // Cron job changes flip session automation badges; push refreshed rows so
  // subscribed session lists update without waiting for unrelated session events.
  const broadcastCronBoundSessionChanges = (evt: CronEvent) => {
    const job = evt.job ?? cron.getJob(evt.jobId);
    if (!job) {
      return;
    }
    const boundKeys = resolveCronJobBoundSessionKeys(job, {
      cfg: getRuntimeConfig(),
      defaultAgentId: cron.getDefaultAgentId(),
    });
    for (const sessionKey of boundKeys) {
      const context = scheduledGatewayContextResolver?.();
      const projection = getSessionRowProjection(context);
      const publish = () =>
        params.broadcast(
          "sessions.changed",
          {
            sessionKey,
            reason: "cron-binding",
            ts: Date.now(),
          },
          { dropIfSlow: true },
        );
      if (projection) {
        void (async () => {
          do {
            await projection.ensureMaterialized();
          } while (projection.needsMaterialization);
          if (scheduledGatewayContextResolver?.() === context) {
            publish();
          }
        })().catch((error: unknown) =>
          cronLogger.warn({ error }, "Cron session publication failed"),
        );
      } else {
        publish();
      }
    }
  };

  const cron = new CronService({
    env,
    scheduler: params.scheduler,
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    describeJobLoadWarning: (job) => describeCronInferenceMigration(getRuntimeConfig(), job),
    listConfiguredChannels: () => listConfiguredMessageChannels(getRuntimeConfig()),
    ...(scriptRuntime ? { evaluateCronTrigger: scriptRuntime.evaluateTrigger } : {}),
    ...(defaultAgentId ? { defaultAgentId } : {}),
    resolveDefaultAgentId: () => tryResolveAmbientOwnerAgentId(getRuntimeConfig()),
    resolveSessionStoreAgentIds: async () => {
      const cfg = getRuntimeConfig();
      try {
        return await listKnownSessionStoreAgentIdsAsync(cfg, { env });
      } catch (error) {
        cronLogger.warn(
          { err: formatErrorMessage(error) },
          "cron: persisted session-store owner discovery failed",
        );
        return listConfiguredSessionStoreAgentIds(cfg);
      }
    },
    isAgentAvailable: (agentId, facts) =>
      !facts.deletionBlocked &&
      !readAgentDatabaseAdmissionRefusal(agentId, { env }) &&
      listAgentIds(getRuntimeConfig()).some((id) => normalizeAgentId(id) === agentId),
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => enqueueCronSystemEvent(text, opts, resolveCronTarget(opts)),
    runSessionEvent: (request) => runGatewayCronSessionEvent(request, resolveCronTarget),
    resolveOriginDeliveryContext: (opts) =>
      resolveGatewayCronOriginDeliveryContext(opts, resolveCronTarget),
    runSchedulerOwned,
    requestHeartbeat: (opts) => requestHeartbeat(resolveCronHeartbeatWake(opts)),
    requestHeartbeatAndWait: (opts, lifecycle) =>
      requestHeartbeatAndWait(resolveCronHeartbeatWake(opts), lifecycle),
    resolveHeartbeatTimeoutMs: (opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts.agentId);
      const heartbeat = resolveHeartbeatForWake({
        cfg: runtimeConfig,
        agentId,
        requestedHeartbeat: opts.heartbeat,
        source: opts.source,
      });
      const timeoutMs = finiteSecondsToTimerSafeMilliseconds(
        resolveHeartbeatTimeoutOverrideSeconds(runtimeConfig, heartbeat),
      );
      return timeoutMs === 0 ? undefined : timeoutMs;
    },
    runIsolatedAgentJob: async (request) => {
      const { job } = request;
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      const sessionKey = `cron:${job.id}`;
      return await runCronIsolatedAgentTurn({
        ...request,
        cfg: runtimeConfig,
        deps: params.deps,
        agentId,
        sessionKey,
        trigger: "cron",
        lane: "cron",
      });
    },
    runCommandJob: async ({ job, abortSignal, deliveryAttemptFence }) => {
      const result = await runCronCommandJob({
        job,
        abortSignal,
        nowMs: Date.now,
      });
      const completion = await finalizeCronCompletionAnnouncement({
        deliveryAttemptFence,
        job,
        text: redactCronCommandSummaryForExternalDelivery(result.summary ?? ""),
        suppressionReason: result.replyDisposition === "silent" ? "silent" : undefined,
        diagnostics: result.diagnostics,
        runStartedAtMs: job.state.runningAtMs,
        abortSignal,
        deps: params.deps,
        resolveCronAgent,
        logger: cronLogger,
        label: "command",
        traceResolvedFailure: true,
      });
      return { ...result, ...completion };
    },
    sendCronWebhook: async ({ job, event, abortSignal, onDeliveryState, assertCurrent }) => {
      return await sendGatewayCronWebhook({
        job,
        event,
        abortSignal,
        onDeliveryState,
        assertCurrent,
        webhookToken: params.cfg.cron?.webhookToken,
        ssrfPolicy: webhookSsrfPolicy,
      });
    },
    runScriptJob: async ({
      job,
      streamBatch,
      abortSignal,
      executionIdentity,
      deliveryAttemptFence,
    }) => {
      if (!scriptRuntime || job.payload.kind !== "script") {
        return {
          status: "error",
          error: "cron script payload executor is unavailable",
          ...cronScriptFailureMetadata("payload", "runtime_unavailable"),
        };
      }
      const execution = await scriptRuntime.executePayload({
        job,
        streamBatch,
        abortSignal,
        executionIdentity,
        deliveryAttemptFence,
      });
      if (execution.kind === "error") {
        return {
          status: "error",
          error: `cron script payload failed (${execution.code}): ${execution.error}`,
          ...cronScriptFailureMetadata("payload", execution.code),
        };
      }
      if (execution.nextCheck && !job.pacing) {
        return {
          status: "error",
          error: "cron script payload returned nextCheck, but this job has no pacing bounds",
          ...cronScriptFailureMetadata("payload", "invalid_input"),
        };
      }

      const preparedNotify = prepareAgentRunTerminalReply({ rawText: execution.notify });
      const notify = preparedNotify.text.trim() ? preparedNotify.text : undefined;
      const base = {
        status: "ok" as const,
        notify,
        wake: execution.wake,
        stateChanged: execution.stateChanged,
        ...(execution.stateChanged ? { state: execution.state } : {}),
        nextCheck: execution.nextCheck,
      };
      const completion = await finalizeCronCompletionAnnouncement({
        deliveryAttemptFence,
        job,
        text: job.sessionTarget === "main" ? undefined : notify,
        suppressionReason:
          preparedNotify.terminalReply.disposition === "silent" ? "silent" : undefined,
        runStartedAtMs: job.state.runningAtMs,
        abortSignal,
        deps: params.deps,
        resolveCronAgent,
        logger: cronLogger,
        label: "script payload",
      });
      return { ...base, ...completion };
    },
    cleanupTimedOutAgentRun: async ({ job, execution }) => {
      if (!execution?.sessionId) {
        return;
      }
      const mcpRetirement = captureSessionMcpRuntimeRetirement({
        sessionId: execution.sessionId,
        sessionKey: execution.sessionKey,
      });
      const cleanup = {
        sessionId: execution.sessionId,
        sessionKey: execution.sessionKey,
        settleMs: 15_000,
        forceClear: true,
        reason: "cron_timeout",
      };
      const result = await (execution.runId
        ? abortAndDrainEmbeddedAgentRunByRunId({ ...cleanup, runId: execution.runId })
        : abortAndDrainEmbeddedAgentRun(cleanup));
      if (!result) {
        cronLogger.warn(
          { jobId: job.id, sessionId: execution.sessionId, sessionKey: execution.sessionKey },
          "cron: timed-out agent run no longer registered; kept the current run",
        );
        return;
      }
      cronLogger.warn(
        {
          jobId: job.id,
          sessionId: execution.sessionId,
          sessionKey: execution.sessionKey,
          aborted: result.aborted,
          drained: result.drained,
          forceCleared: result.forceCleared,
        },
        "cron: cleaned up timed-out agent run",
      );
      await mcpRetirement
        ?.retire(() => params.scheduler.signal.throwIfAborted())
        .catch((error: unknown) => {
          cronLogger.warn(
            { jobId: job.id, sessionId: execution.sessionId },
            `cron: failed to retire MCP runtime for timed-out session: ${String(error)}`,
          );
        });
    },
    onIsolatedAgentSetupTimeout: ({ job, error, timeoutMs }) => {
      cronLogger.warn(
        {
          jobId: job.id,
          jobName: job.name,
          timeoutMs,
          error,
        },
        "cron: isolated agent setup timed out before runner start; backing off job without gateway restart",
      );
    },
    sendCronFailureAlert: async (alert) =>
      await sendGatewayCronFailureAlert({
        ...alert,
        deps: params.deps,
        logger: cronServiceLogger,
        resolveCronAgent,
        webhookToken: params.cfg.cron?.webhookToken,
        ssrfPolicy: webhookSsrfPolicy,
      }),
    ...createGatewayCronFailureRepair(params.cfg, scheduledGatewayContextResolver),
    log: toPinoLikeLogger(
      getChildLogger({ module: "cron", storeKey: storePath }),
      getResolvedLoggerSettings().level,
    ),
    onEvent: (evt) => {
      // Any job/store change can alter session automation bindings, including
      // in-place enable flips during runs; the index publishes only binding deltas.
      invalidateSessionAutomationIndex();
      const jobSnapshot = evt.job ?? cron.getJob(evt.jobId);
      const scopedSessionKey =
        jobSnapshot?.owner?.sessionKey ??
        (jobSnapshot && resolveCronSessionTargetSessionKey(jobSnapshot.sessionTarget)) ??
        jobSnapshot?.sessionKey ??
        evt.sessionKey;
      const scopedAgentId = jobSnapshot?.owner?.agentId ?? jobSnapshot?.agentId;
      // Views fetch definitions and run details on demand; the sidebar only needs
      // attention state. Keep the full event for hooks and notifications below.
      const {
        job: eventJob,
        summary: _summary,
        diagnostics: _diagnostics,
        delivery: _delivery,
        ...event
      } = evt;
      const payload = {
        ...event,
        ...(eventJob
          ? {
              job: {
                ...pickDefined(eventJob, ["id", "name", "agentId", "enabled", "updatedAtMs"]),
                state: pickDefined(eventJob.state, [
                  "nextRunAtMs",
                  "lastRunAtMs",
                  "lastRunStatus",
                  "lastStatus",
                  "runningAtMs",
                  "autoDisabled",
                ]),
              },
            }
          : {}),
      };
      params.broadcast("cron", payload, {
        dropIfSlow: true,
        ...(scopedSessionKey
          ? {
              sessionKeys: [scopedSessionKey],
              ...(scopedAgentId ? { agentId: scopedAgentId } : {}),
            }
          : {}),
      });
      runCronChangedHook(toPluginCronChangedEvent(evt, jobSnapshot));
      // Re-arm / cancel scheduler-owned process watchers when the job set changes.
      if (evt.action === "added" || evt.action === "updated" || evt.action === "removed") {
        broadcastCronBoundSessionChanges(evt);
        void reconcileExitWatchers();
        // cron.update and cron.add (including declarative convergence) route
        // lifecycle after the mutation. Ignoring state-only update events keeps
        // owner status/counter persistence from recursively restarting its process.
        if (evt.action !== "updated") {
          void routeStreamWatcherMutation(
            evt.jobId,
            evt.job ?? cron.getJob(evt.jobId),
            evt.action,
          ).catch((err: unknown) => {
            cronLogger.warn(
              { err: formatErrorMessage(err), jobId: evt.jobId },
              "cron-stream: route failed",
            );
          });
        }
      } else if (evt.action === "finished") {
        // Runs can flip enabled without an "updated" event (one-shot success,
        // trigger.once, schedule-error auto-disable); refresh badges then too.
        // Fully deleted jobs emit their own "removed" event instead.
        const finishedJob = evt.job ?? cron.getJob(evt.jobId);
        if (finishedJob?.enabled === false) {
          broadcastCronBoundSessionChanges(evt);
          void routeStreamWatcherMutation(evt.jobId, finishedJob, "finished").catch(
            (err: unknown) => {
              cronLogger.warn(
                { err: formatErrorMessage(err), jobId: evt.jobId },
                "cron-stream: route failed",
              );
            },
          );
        }
      }
      if (evt.action === "finished") {
        const job = evt.job ?? cron.getJob(evt.jobId);
        dispatchGatewayCronFinishedNotifications({
          evt,
          job,
          logger: cronServiceLogger,
          webhookToken: params.cfg.cron?.webhookToken,
          ssrfPolicy: webhookSsrfPolicy,
        });
      }
    },
  });

  const exitWatcherHandlers = {
    getDefaultAgentId: () => cron.getDefaultAgentId(),
    getProcessSupervisor,
    fireOnExit: async (job, exit, controls) => {
      // Reload adopts children before draining the previous scheduler. Its
      // global run cancellation must finish before this owner admits their exits.
      if (
        exitWatcherHandoffReady &&
        !(await racePromiseWithAbortSignal(exitWatcherHandoffReady.result.promise, controls.signal))
      ) {
        throw new Error("cron on-exit replacement scheduler did not start");
      }
      controls.commitGuard();
      if (getGatewaySuspendAdmissionPhase() === "draining") {
        const completionToken: Parameters<CronService["updateWithPrecondition"]>[2] = (current) => {
          controls.commitGuard();
          if (!current.enabled || current.updatedAtMs !== job.updatedAtMs) {
            throw new Error("cron on-exit job changed before completion");
          }
        };
        terminalExitCompletionTokens.set(job.id, completionToken);
        controls.onTerminalWriteStarted();
        try {
          // Consume an already-owned exit during drain without admitting a new payload.
          await cron.updateWithPrecondition(job.id, { enabled: false }, completionToken, {
            commitGuard: controls.commitGuard,
          });
          controls.onReserved();
          controls.commitGuard();
          throw new Error(
            `cron on-exit run was not admitted: gateway draining\n\n${truncateUtf16WithEllipsis(formatOnExitRunSummary(exit), 2_000)}`,
          );
        } finally {
          if (terminalExitCompletionTokens.get(job.id) === completionToken) {
            terminalExitCompletionTokens.delete(job.id);
          }
          void reconcileExitWatchers();
        }
      }
      await runWithGatewayIndependentRootWorkAdmission(
        async () =>
          fireOnExitJob(job, exit, {
            run: (jobId, payload) =>
              cron.runOnExit(jobId, {
                schedule: job.schedule,
                signal: controls.signal,
                commitGuard: controls.commitGuard,
                onReserved: controls.onReserved,
                payload,
              }),
          }),
        "cron:exit-hook",
        controls.signal,
      );
    },
    updateWatcherState: async (job, patch) =>
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        try {
          // A retired watch must not write failure state onto its replacement.
          return await cron.updateWithPrecondition(job.id, { state: patch }, (current) => {
            if (
              !current.enabled ||
              current.schedule.kind !== "on-exit" ||
              current.updatedAtMs !== job.updatedAtMs
            ) {
              throw new Error("cron on-exit job changed before watcher-state write");
            }
          });
        } catch {
          // Stale watcher identity is a no-op, not an error to surface.
          return undefined;
        }
      }, "cron:watcher-state"),
    logger: cronServiceLogger,
  } satisfies CronExitWatcherHandlers;
  exitWatchers = createCronExitWatchers(exitWatcherHandlers, params.scheduler);
  const streamWatchers = createCronStreamWatchers({
    getDefaultAgentId: () => cron.getDefaultAgentId(),
    scheduler: params.scheduler,
    getProcessSupervisor,
    spawnSandboxSource: async (input) => (await getSandboxStreams()).spawn(input),
    updateState: async (jobId, patch, streamScheduleKey, streamSourceIdentity) => {
      return await cron.updateExternalState(jobId, streamScheduleKey, streamSourceIdentity, patch);
    },
    retireSource: async (jobId, streamScheduleKey, streamSourceIdentity) =>
      await cron.retireExternalStreamSource(jobId, streamScheduleKey, streamSourceIdentity),
    updateCounters: async (jobId, counters) => {
      await cron.updateExternalCounters(jobId, counters);
    },
    recordFailure: async (jobId, error, patch, streamScheduleKey, streamSourceIdentity) => {
      await cron.recordExternalFailure(jobId, error, patch, {
        scheduleKey: streamScheduleKey,
        identity: streamSourceIdentity,
      });
    },
    fireBatch: (job, batch, streamScheduleKey, streamSourceIdentity) =>
      runWithGatewayIndependentRootWorkAdmission(
        async () =>
          fireStreamJob(job, {
            run: async (jobId, onDisposition) => {
              const result = await cron.run(jobId, "force", {
                evaluateTrigger: true,
                streamBatch: batch,
                streamScheduleKey,
                streamSourceIdentity,
                onTriggerDisposition: onDisposition,
              });
              return { ...result, enabled: cron.getJob(jobId)?.enabled };
            },
          }),
        "cron:stream-batch",
      ),
    logger: cronServiceLogger,
  });
  const cancelDisabledExitWatcher = (job: CronJob) => {
    if (job.enabled || job.schedule.kind !== "on-exit") {
      return;
    }
    // An operator disable wins over a completion retained during owner handoff.
    exitWatcherMutationRevision += 1;
    exitWatchers?.cancel(job.id);
  };
  const addCron = cron.add.bind(cron);
  cron.add = async (input, options) => {
    const result = await addCron(input, options);
    const addedJob = "job" in result ? result.job : result;
    if (options?.enabledExplicit && !input.enabled) {
      cancelDisabledExitWatcher(addedJob);
    }
    await routeStreamWatcherMutation(addedJob.id, addedJob, "added");
    const observed = withObservedCronStreamState(cron, addedJob);
    return "job" in result ? { ...result, ...observed, job: observed } : observed;
  };
  // Watcher routing after a committed mutation is lifecycle repair, not part
  // of the mutation result: a stubborn child failing again must not turn an
  // already-persisted change into a caller-visible error.
  const routeLiveStreamJobLogged = async (jobId: string) => {
    try {
      const current = cron.getJob(jobId);
      await routeStreamWatcherMutation(jobId, current, current ? "updated" : "removed");
    } catch (error) {
      cronLogger.warn(
        { jobId, err: String(error) },
        "cron-stream: post-commit lifecycle routing failed",
      );
    }
  };
  const updateWithWatchers = bindCronStreamUpdate({
    cron,
    streamWatchers,
    reconcile: routeLiveStreamJobLogged,
    cancelDisabledExitWatcher: (job, precondition) => {
      if (!precondition || terminalExitCompletionTokens.get(job.id) !== precondition) {
        cancelDisabledExitWatcher(job);
      }
    },
    logger: cronLogger,
  });
  cron.update = (jobId, patch, opts) => updateWithWatchers(jobId, patch, opts);
  cron.updateWithPrecondition = (jobId, patch, precondition, opts) =>
    updateWithWatchers(jobId, patch, opts, precondition);
  cron.remove = bindCronStreamRemoval({
    cron,
    streamWatchers,
    reconcile: routeLiveStreamJobLogged,
  });
  const getCronSuspensionBlockerCount = cron.getSuspensionBlockerCount.bind(cron);
  cron.getSuspensionBlockerCount = () =>
    getCronSuspensionBlockerCount() +
    Number(startPromise !== undefined) +
    exitWatcherReconciliations +
    streamWatcherReconciliations +
    (exitWatchers?.activeJobIds().length ?? 0) +
    (streamWatchers?.activeJobIds().length ?? 0);
  // cron.stop begins cancellation synchronously; stopAndDrain joins this same
  // settlement so a replacement owner cannot start over live predecessors.
  let exitWatchersStopPromise: Promise<void> | undefined;
  const stopExitWatchers = () => {
    // Late completion cleanup can request reconciliation after shutdown.
    // Fence new requests before cancellation so stopped children cannot respawn.
    exitWatchersStopped = true;
    exitWatcherMutationRevision += 1;
    if (!exitWatchersStopPromise) {
      exitWatchersStopPromise = exitWatchers?.cancelAll() ?? Promise.resolve();
      void exitWatchersStopPromise.catch((err: unknown) => {
        cronLogger.warn(
          { err: formatErrorMessage(err) },
          "cron-exit: asynchronous teardown failed",
        );
      });
    }
  };
  // cron.stop launches this teardown asynchronously and stopAndDrain awaits
  // it; memoizing keeps that one drain instead of queueing every owner a
  // second shutdown stop whose bounded wait could spuriously time out.
  let streamWatchersStopPromise: Promise<void> | undefined;
  const stopStreamWatchers = (): Promise<void> => {
    if (streamWatchersStopPromise) {
      return streamWatchersStopPromise;
    }
    const stopPromise = (async () => {
      streamWatcherMutationRevision += 1;
      streamWatchersStopped = true;
      await streamWatchers?.stopAll("shutdown");
    })();
    streamWatchersStopPromise = stopPromise;
    void stopPromise.catch(() => {
      // Owners retain failed process handles so a later drain can retry them;
      // only overlapping callers should share the rejected attempt.
      if (streamWatchersStopPromise === stopPromise) {
        streamWatchersStopPromise = undefined;
      }
    });
    return stopPromise;
  };
  const automationSource = {
    getJobs: () => cron.getLoadedJobs(),
    getDefaultAgentId: () => cron.getDefaultAgentId(),
  };
  const stopCron = cron.stop.bind(cron);
  let stopped = false;
  let started = false;
  let startPromise: Promise<void> | undefined;
  let schedulingPaused = false;
  let schedulingResume: Deferred | undefined;
  const stopCronLifecycle = (preserveExitWatchers = false) => {
    stopped = true;
    started = false;
    schedulingResume?.resolve();
    schedulingResume = undefined;
    settleExitWatcherHandoff(false);
    try {
      stopCron();
      if (preserveExitWatchers) {
        // A committed replacement owns these children; fence this scheduler
        // without terminating the adopted manager.
        exitWatchersStopped = true;
        exitWatcherMutationRevision += 1;
      } else {
        stopExitWatchers();
      }
      systemJobs.stop();
      void stopStreamWatchers().catch((err: unknown) => {
        cronLogger.warn(
          { err: formatErrorMessage(err) },
          "cron-stream: asynchronous teardown failed",
        );
      });
    } finally {
      // Session rows must stop reporting automation from a stopped scheduler,
      // but a reload's replacement service may already own the registration.
      unregisterSessionAutomationSource(automationSource);
    }
  };
  cron.stop = () => {
    stopCronLifecycle();
  };
  const stopAndDrainCron = async (preserveExitWatchers = false) => {
    stopCronLifecycle(preserveExitWatchers);
    await drainGatewayCron({
      settlements: [
        cron.waitForIdle(),
        startPromise ?? Promise.resolve(),
        systemJobs.drain(),
        exitWatchersStopPromise ?? Promise.resolve(),
        stopStreamWatchers(),
      ],
      logger: cronLogger,
    });
  };
  cron.stopAndDrain = () => stopAndDrainCron();
  const systemJobs = createGatewayCronSystemJobReconciler({
    cron,
    scheduler: params.scheduler,
    storePath,
    getRuntimeConfig,
    logger: cronServiceLogger,
  });
  const pauseScheduling = cron.pauseScheduling.bind(cron);
  const resumeScheduling = cron.resumeScheduling.bind(cron);
  cron.pauseScheduling = () => {
    schedulingPaused = true;
    pauseScheduling();
  };
  cron.resumeScheduling = () => {
    schedulingPaused = false;
    schedulingResume?.resolve();
    schedulingResume = undefined;
    resumeScheduling();
  };
  const startCron = cron.start.bind(cron);
  const startCronLifecycle = async () => {
    if (exitWatcherHandoffReady?.settled) {
      exitWatcherHandoffReady = { result: createDeferredCore<boolean>(), settled: false };
    }
    // A failed start keeps observed exits parked for retry; stop cancels them.
    const handoff = exitWatcherHandoffReady;
    await Promise.all([exitWatchersStopPromise, streamWatchersStopPromise]);
    if (stopped) {
      return;
    }
    if (schedulingPaused) {
      schedulingResume ??= createDeferredCore();
      await schedulingResume.promise;
    }
    if (stopped) {
      return;
    }
    await startCron();
    if (stopped) {
      return;
    }
    try {
      await (await getSandboxStreams()).recover();
    } catch (error) {
      cronLogger.warn(
        { err: formatErrorMessage(error) },
        "cron-stream: sandbox cleanup requires attention",
      );
    }
    if (stopped) {
      return;
    }
    exitWatchersStopped = false;
    streamWatchersStopped = false;
    // A restart owns a fresh watcher lifecycle; the next stop must drain it.
    exitWatchersStopPromise = undefined;
    streamWatchersStopPromise = undefined;
    streamWatchers?.resume();
    // Persisted on-exit jobs have no change event to arm their children.
    await Promise.all([
      cronEnabled ? reconcileExitWatchers() : undefined,
      reconcileStreamWatchers(),
    ]);
    if (stopped) {
      return;
    }
    systemJobs.resume();
    await systemJobs.reconcile();
    if (stopped) {
      return;
    }
    registerSessionAutomationSource(automationSource);
    // Nudge subscribed clients into a canonical list refresh so automation
    // badges match this scheduler's bindings — including clearing them when a
    // reload lands on an empty or disabled store.
    params.broadcast(
      "sessions.changed",
      { reason: "cron-bindings-loaded", ts: Date.now() },
      { dropIfSlow: true },
    );
    if (handoff) {
      settleExitWatcherHandoff(true, handoff);
    }
    started = true;
  };
  cron.start = async () => {
    if (started) {
      return;
    }
    if (startPromise) {
      // A stop cancels this operation; callers retry after its drain, rather
      // than replaying a new lifecycle inside the cancelled startup.
      return await startPromise;
    }
    stopped = false;
    startPromise = startCronLifecycle();
    try {
      await startPromise;
    } finally {
      startPromise = undefined;
    }
  };

  return {
    cron,
    storePath,
    cronEnabled,
    prepareExitWatcherHandoff: async () => ({
      current: () => exitWatchers!,
      adopt: (watchers) => {
        if (watchers !== exitWatchers) {
          settleExitWatcherHandoff(false);
          exitWatcherHandoffReady = { result: createDeferredCore<boolean>(), settled: false };
          exitWatcherMutationRevision += 1;
        }
        exitWatchers = watchers;
        return watchers.updateHandlers(exitWatcherHandlers);
      },
      stopOwner: async () => {
        await stopAndDrainCron(true);
      },
    }),
    reconcileExitWatchers,
    reconcileStreamWatchers,
    stopStreamWatchers,
    reconcileSystemJobs: systemJobs.reconcile,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
