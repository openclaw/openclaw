import path from "node:path";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { ACP_SESSION_IDENTITY_RENDERER_VERSION } from "../acp/runtime/session-identifiers.js";
import { initA2AConcurrencyGate } from "../agents/a2a-concurrency.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles } from "../agents/session-write-lock.js";
import { initA2AJobManager } from "../agents/tools/a2a-job-manager.js";
import { resumeFlows } from "../agents/tools/a2a-job-orchestrator.js";
import { A2AJobReaper } from "../agents/tools/a2a-job-reaper.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveA2AConcurrencyConfig } from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { startA2aRetryScheduler } from "../discord/a2a-retry/index.js";
import { startDmRetryScheduler } from "../discord/dm-retry/scheduler.js";
import {
  registerThreadParticipantExitHandler,
  startThreadParticipantMaintenance,
} from "../discord/monitor/thread-participants.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { startA2AIndex } from "../infra/events/a2a-index.js";
import { startEventLog } from "../infra/events/event-log.js";
import { SinkRegistry } from "../infra/events/sink-registry.js";
import { DiscordConversationSink } from "../infra/events/sinks/discord-conversation-sink.js";
import { startTaskContinuationRunner } from "../infra/task-continuation-runner.js";
import { scheduleTaskContinuation } from "../infra/task-continuation.js";
import { startTaskSelfDriving } from "../infra/task-self-driving.js";
import { startTaskStepContinuation } from "../infra/task-step-continuation.js";
import { startTaskTracker } from "../infra/task-tracker.js";
import {
  cleanupStaleTasks,
  registerTaskEnforcerHook,
} from "../plugins/core-hooks/task-enforcer.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
}) {
  const stateDir = resolveStateDir(process.env);

  try {
    const sessionDirs = await resolveAgentSessionDirs(stateDir);
    for (const sessionsDir of sessionDirs) {
      await cleanStaleLockFiles({
        sessionsDir,
        staleMs: SESSION_LOCK_STALE_MS,
        removeStale: true,
        log: { warn: (message) => params.log.warn(message) },
      });
    }
  } catch (err) {
    params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
  }

  // Clean up stale task files (in_progress/pending for >24h → abandoned).
  // Prevents task enforcement bypass via orphaned in-progress tasks.
  try {
    const cfg = params.cfg;
    const agentList = cfg.agents?.list ?? [];
    const defaultAgentId = resolveDefaultAgentId(cfg);
    const agentIds = new Set<string>();
    agentIds.add(normalizeAgentId(defaultAgentId));
    for (const entry of agentList) {
      if (entry?.id) {
        agentIds.add(normalizeAgentId(entry.id));
      }
    }
    let totalCleaned = 0;
    for (const agentId of agentIds) {
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      totalCleaned += await cleanupStaleTasks(workspaceDir, agentId);
    }
    if (totalCleaned > 0) {
      params.log.warn(`cleaned up ${totalCleaned} stale task file(s) on startup`);
    }
  } catch (err) {
    params.log.warn(`stale task cleanup failed on startup: ${String(err)}`);
  }

  // Register the task enforcer hook so agents must call task_start() before work tools.
  registerTaskEnforcerHook(params.pluginRegistry);

  // Start A2A conversation index (O(1) conversationId lookup, replaces NDJSON scan).
  try {
    startA2AIndex(stateDir);

    // Start coordination event log writer (appends events to coordination-events.ndjson).
    startEventLog(path.join(stateDir, "logs"));
    initA2AConcurrencyGate(resolveA2AConcurrencyConfig(params.cfg));

    // Initialize A2A Job Manager (durable persistence for A2A flows)
    const jobManager = initA2AJobManager(stateDir);
    await jobManager.init();

    // Run reaper on startup: abandon stale jobs, reset others for resume
    const reaper = new A2AJobReaper(jobManager);
    await reaper.runOnStartup();

    // Resume any PENDING jobs from previous gateway session
    const resumable = await reaper.getResumableJobs();
    if (resumable.length > 0) {
      void resumeFlows(resumable);
    }
  } catch (err) {
    params.log.warn(`a2a subsystem failed to start: ${String(err)}`);
  }

  // Start conversation sinks (replaces old task-hub-sink).
  const sinkRegistry = new SinkRegistry();
  sinkRegistry.register(new DiscordConversationSink());
  try {
    const sinkConfigs = params.cfg.gateway?.conversationSinks ?? [];
    sinkRegistry.startAll(sinkConfigs);
  } catch (err) {
    params.log.warn(`conversation sink startup failed: ${String(err)}`);
  }
  // Start OpenClaw browser control server (unless disabled via config).
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  try {
    browserControl = await startBrowserControlServerIfEnabled();
  } catch (err) {
    params.logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  await startGmailWatcherWithLogs({
    cfg: params.cfg,
    log: params.logHooks,
  });

  // Validate hooks.gmail.model if configured.
  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  // Start DM retry scheduler for Discord agent-to-agent communication.
  try {
    startDmRetryScheduler(params.cfg);
  } catch (err) {
    params.log.warn(`dm-retry scheduler failed to start: ${String(err)}`);
  }

  // Start A2A mention retry scheduler for Discord thread communication.
  try {
    startA2aRetryScheduler(params.cfg);
  } catch (err) {
    params.log.warn(`a2a-retry scheduler failed to start: ${String(err)}`);
  }

  // Start thread participant maintenance (periodic GC + exit flush).
  registerThreadParticipantExitHandler();
  const threadParticipantMaintenance = startThreadParticipantMaintenance();

  // Start task tracker for automatic CURRENT_TASK.md updates.
  try {
    startTaskTracker(params.cfg);
  } catch (err) {
    params.log.warn(`task-tracker failed to start: ${String(err)}`);
  }

  // Load internal hook handlers from configuration and directory discovery.
  try {
    // Clear any previously registered hooks to ensure fresh loading
    clearInternalHooks();
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via OPENCLAW_SKIP_CHANNELS (or legacy OPENCLAW_SKIP_PROVIDERS).
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  }

  if (params.cfg.hooks?.internal?.enabled) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  if (params.cfg.acp?.enabled) {
    void getAcpSessionManager()
      .reconcilePendingSessionIdentities({ cfg: params.cfg })
      .then((result) => {
        if (result.checked === 0) {
          return;
        }
        params.log.warn(
          `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
        );
      })
      .catch((err) => {
        params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
      });
  }

  void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
  });

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  if (shouldWakeFromRestartSentinel()) {
    scheduleTaskContinuation({
      cfg: params.cfg,
      deps: params.deps,
      delayMs: 1500,
    });
  }

  // Start task continuation runners (backlog auto-pickup, self-driving, step continuation).
  const taskContinuationRunner = startTaskContinuationRunner({ cfg: params.cfg });
  const taskSelfDriving = startTaskSelfDriving({ cfg: params.cfg });
  const taskStepContinuation = startTaskStepContinuation({ cfg: params.cfg });

  return {
    browserControl,
    pluginServices,
    taskContinuationRunner,
    taskSelfDriving,
    taskStepContinuation,
    threadParticipantMaintenance,
  };
}
