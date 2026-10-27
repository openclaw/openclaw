import { captureSessionMcpRuntimeRetirement } from "../agents/agent-bundle-mcp-manager-api.js";
import { prepareAgentRunTerminalReply } from "../agents/agent-run-terminal-reply.js";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { abortAndDrainEmbeddedAgentRunByRunId } from "../agents/embedded-agent-runner/runs.js";
import { abortAndDrainEmbeddedAgentRun } from "../agents/embedded-agent.js";
import { loadPreparedInboundPluginRegistry } from "../agents/prepared-model-runtime.inbound-registry.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import type { CliDeps } from "../cli/deps.types.js";
import { DEFAULT_CRON_ENABLED } from "../config/cron-limits.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listKnownSessionStoreAgentIdsAsync } from "../config/sessions/targets-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import { redactCronCommandSummaryForExternalDelivery } from "../cron/command-output-summary.js";
import { runCronCommandJob } from "../cron/command-runner.js";
import { isCronExecutionIdle } from "../cron/execution-idle.js";
import { cronScriptFailureMetadata } from "../cron/script-failure.js";
import { CronService } from "../cron/service.js";
import { resolveCronSessionTargetSessionKey } from "../cron/session-target.js";
import { createCronScriptRuntime } from "../cron/trigger-script.js";
import type { CronJob } from "../cron/types.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { emitLegacyHeartbeatCronOutcome } from "../infra/heartbeat-events.js";
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
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { truncateUtf16WithEllipsis } from "../shared/text-truncate.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
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
import { createGatewayCronAgentDeps } from "./server-cron-agent-run.js";
import { finalizeCronCompletionAnnouncement, pickDefined } from "./server-cron-completion.js";
import type { GatewayCronState } from "./server-cron-contract.js";
import {
  bindCronStreamRemoval,
  bindCronStreamUpdate,
  drainGatewayCron,
  withObservedCronStreamState,
} from "./server-cron-drain.js";
import {
  admitGatewayCronOccurrence,
  enqueueCronSystemEvent,
  fireOnExitJob,
  fireStreamJob,
  formatOnExitRunSummary,
  resolveGatewayCronOriginDeliveryContext,
  runGatewayCronSessionEvent,
} from "./server-cron-event-dispatch.js";
import { createGatewayCronHeartbeatSummary } from "./server-cron-heartbeat-summary.js";
import { describeCronInferenceMigration } from "./server-cron-inference.js";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronWebhook,
  sendGatewayCronFailureAlert,
  createGatewayCronFailureRepair,
} from "./server-cron-notifications.js";
import { toPluginCronChangedEvent } from "./server-cron-plugin-job.js";
import { createGatewayCronPublisher } from "./server-cron-publication.js";
import { createGatewayCronTargetResolver } from "./server-cron-targets.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  registerSessionAutomationSource,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";

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
  const { storePath, env = process.env } = params;
  const cronEnabled =
    env.OPENCLAW_SKIP_CRON !== "1" && (params.cfg.cron?.enabled ?? DEFAULT_CRON_ENABLED);
  const hostExecutionDisabled = isTruthyEnvValue(env.OPENCLAW_DISABLE_CRON_HOST_EXECUTION);
  // Resolve once per cron service snapshot so every webhook route shares the
  // same explicit opt-in while omitted config keeps the guard strict.
  const webhookSsrfPolicy = mergeSsrFPolicies(params.cfg.cron?.webhookSsrfPolicy);

  const { resolveCronAgent, resolveCronTarget, deferSessionEvent, enqueueSessionEvent } =
    createGatewayCronTargetResolver(env, cronLogger);

  const defaultAgentId = tryResolveAmbientOwnerAgentId(params.cfg);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: agentId ?? resolveSessionStoreCompatibilityAgentId(getRuntimeConfig()),
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const cronTriggersEnabled = params.cfg.cron?.triggers?.enabled !== false;
  const cronScriptsEnabled = cronTriggersEnabled && !hostExecutionDisabled;
  const scriptRuntime = cronScriptsEnabled
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
          storeKey: cron.getStoreKey(),
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
      if (cronEnabled && !hostExecutionDisabled) {
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
    action: "added" | "updated" | "removed" | "finished",
  ) => {
    const watchers = streamWatchers;
    if (!watchers || streamWatchersStopped) {
      return;
    }
    streamWatcherMutationRevision += 1;
    streamWatcherReconciliations += 1;
    try {
      // Public event jobs omit the trusted sandbox target; use the stored job for execution routing.
      const job = action === "removed" ? undefined : cron.getJob(jobId);
      if (!job) {
        await watchers.stop(jobId, "removed");
        return;
      }
      if (
        job.schedule.kind === "stream" &&
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
        restartExhausted: job.state.streamRestartExhausted === true,
        isStream: job.schedule.kind === "stream",
      });
      await watchers.stop(jobId, reason, job);
    } finally {
      streamWatcherReconciliations -= 1;
    }
  };

  const publishCronInventoryChange = createGatewayCronPublisher({
    broadcast: params.broadcast,
    getCron: () => cron,
    resolveGatewayContext: scheduledGatewayContextResolver,
    logger: cronLogger,
  });

  const heartbeatSummary = createGatewayCronHeartbeatSummary({
    storePath,
    prepareStoreKey: () => cron.prepareStoreKey(),
    isStopped: () => stopped,
  });
  const readHeartbeatSummary = (cfg: OpenClawConfig) => heartbeatSummary.read(cfg);
  const legacyMonitorJobs = new Map<string, CronJob>();
  let legacyProjectionClosed = false;
  let legacyProjectionRevision = 0;
  const refreshLegacyMonitorProjection = async () => {
    const revision = ++legacyProjectionRevision;
    const cfg = getRuntimeConfig();
    try {
      const jobs = await readHeartbeatSummary(cfg);
      if (
        legacyProjectionClosed ||
        revision !== legacyProjectionRevision ||
        cfg !== getRuntimeConfig()
      ) {
        return;
      }
      legacyMonitorJobs.clear();
      for (const job of jobs) {
        legacyMonitorJobs.set(job.id, job);
      }
    } catch (error) {
      cronLogger.warn({ error }, "Legacy heartbeat diagnostics could not read automation state");
    }
  };
  const cron = new CronService({
    env,
    onProvisionedJobsReloaded: async () => {
      await Promise.all([
        reconcileExitWatchers(),
        reconcileStreamWatchers(),
        started ? refreshLegacyMonitorProjection() : undefined,
      ]);
    },
    isExecutionIdle: (job, ownSessionKey, ownReplyOperation) => {
      const cfg = getRuntimeConfig();
      const agentId = resolveCronJobEffectiveAgentId(job, tryResolveAmbientOwnerAgentId(cfg));
      return Boolean(
        agentId && isCronExecutionIdle(cfg, job, agentId, ownSessionKey, ownReplyOperation),
      );
    },
    resolveUserTimezone: () => getRuntimeConfig().agents?.defaults?.userTimezone,
    scheduler: params.scheduler,
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    describeJobLoadWarning: (job) => describeCronInferenceMigration(getRuntimeConfig(), job),
    hostExecutionDisabled,
    listConfiguredChannels: () => listConfiguredMessageChannels(getRuntimeConfig()),
    admitScheduledOccurrence: ({ job }) => admitGatewayCronOccurrence(job, resolveCronAgent),
    ...(scriptRuntime ? { evaluateCronTrigger: scriptRuntime.evaluateTrigger } : {}),
    ...(defaultAgentId ? { defaultAgentId } : {}),
    resolveDefaultAgentId: () => tryResolveAmbientOwnerAgentId(getRuntimeConfig()),
    resolveSessionEventTarget: resolveCronTarget,
    captureSessionEventTarget: async (job) => {
      const { agentId, sessionKey } = resolveCronTarget({
        agentId: job.agentId,
        sessionKey: resolveCronSessionTargetSessionKey(job.sessionTarget) ?? job.sessionKey,
      });
      return agentId && sessionKey
        ? await captureSessionEventTargetForHost(agentId, sessionKey, { env })
        : undefined;
    },
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
    enqueueSessionEvent,
    deferSessionEvent,
    ...createGatewayCronAgentDeps({
      deps: params.deps,
      storePath,
      resolveCronAgent,
      resolveGatewayContext: scheduledGatewayContextResolver,
      resolvePluginRegistry: params.resolvePluginRegistry,
    }),
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
    runScriptJob: async (request) => {
      const { job, abortSignal, deliveryAttemptFence } = request;
      if (!scriptRuntime || job.payload.kind !== "script") {
        return {
          status: "error",
          error: "cron script payload executor is unavailable",
          ...cronScriptFailureMetadata("payload", "runtime_unavailable"),
        };
      }
      const execution = await scriptRuntime.executePayload(request);
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
    onDefinitionChange: publishCronInventoryChange,
    onEvent: (evt) => {
      const jobSnapshot = evt.job ?? cron.getJob(evt.jobId);
      if (legacyMonitorJobs.has(evt.jobId)) {
        legacyProjectionRevision += 1;
        if (evt.action === "removed") {
          legacyMonitorJobs.delete(evt.jobId);
        } else if (jobSnapshot) {
          legacyMonitorJobs.set(evt.jobId, jobSnapshot);
        }
        if (evt.action === "finished") {
          emitLegacyHeartbeatCronOutcome(evt);
        }
      } else if (evt.action === "added") {
        void refreshLegacyMonitorProjection();
      }
      const scopedSessionKey =
        jobSnapshot?.owner?.sessionKey ??
        (jobSnapshot && resolveCronSessionTargetSessionKey(jobSnapshot.sessionTarget)) ??
        jobSnapshot?.sessionKey ??
        evt.sessionKey;
      const scopedAgentId = jobSnapshot?.owner?.agentId ?? jobSnapshot?.agentId;
      // Views fetch definitions and run details on demand; the sidebar needs
      // bounded status and freshness. Keep the full event for hooks and notifications below.
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
                  "lastDurationMs",
                  "lastTriggerEvalAtMs",
                  "lastMeaningfulResult",
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
        void reconcileExitWatchers();
        // cron.update and cron.add (including declarative convergence) route
        // lifecycle after the mutation. Ignoring state-only update events keeps
        // owner status/counter persistence from recursively restarting its process.
        if (evt.action !== "updated") {
          void routeStreamWatcherMutation(evt.jobId, evt.action).catch((err: unknown) => {
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
          void routeStreamWatcherMutation(evt.jobId, "finished").catch((err: unknown) => {
            cronLogger.warn(
              { err: formatErrorMessage(err), jobId: evt.jobId },
              "cron-stream: route failed",
            );
          });
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
    hostExecutionDisabled,
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
    await routeStreamWatcherMutation(addedJob.id, "added");
    const observed = withObservedCronStreamState(cron, addedJob);
    return "job" in result ? { ...result, ...observed, job: observed } : observed;
  };
  // Watcher routing after a committed mutation is lifecycle repair, not part
  // of the mutation result: a stubborn child failing again must not turn an
  // already-persisted change into a caller-visible error.
  const routeLiveStreamJobLogged = async (jobId: string) => {
    try {
      await routeStreamWatcherMutation(jobId, "updated");
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
    heartbeatSummary.clear();
    started = false;
    legacyProjectionClosed = true;
    legacyProjectionRevision += 1;
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
        exitWatchersStopPromise ?? Promise.resolve(),
        stopStreamWatchers(),
      ],
      logger: cronLogger,
    });
  };
  cron.stopAndDrain = () => stopAndDrainCron();
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
    legacyProjectionClosed = false;
    await refreshLegacyMonitorProjection();
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
    readHeartbeatSummary,
    deferHookWake: (opts) => cron.deferHookWake(opts),
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
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
