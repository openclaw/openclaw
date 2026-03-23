import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { ACP_SESSION_IDENTITY_RENDERER_VERSION } from "../acp/runtime/session-identifiers.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles } from "../agents/session-write-lock.js";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { initStateDb } from "../infra/state-db/index.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { reconcileAgentConfigOnStartup } from "./server-startup-agent-sync.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
}) {
  // Initialize operator1 state database (SQLite).
  try {
    initStateDb();
  } catch (err) {
    params.log.warn(`state-db init failed: ${String(err)}`);
  }

  // Scan ~/.openclaw/commands/*.md and sync user-created commands into SQLite.
  try {
    const { scanCommandFiles } = await import("../infra/state-db/commands-scanner.js");
    scanCommandFiles(params.log);
  } catch (err) {
    params.log.warn(`commands-scanner failed: ${String(err)}`);
  }

  // One-shot migration: JSON session stores → SQLite.
  try {
    const { migrateSessionStoresToSqlite } = await import("../config/sessions/store-migrate.js");
    const results = migrateSessionStoresToSqlite();
    const migrated = results.filter((r) => r.migrated && r.entriesCount > 0);
    if (migrated.length > 0) {
      params.log.info(
        `[state-db] Migrated sessions for ${migrated.length} agent(s) from JSON to SQLite`,
      );
    }
    const failed = results.filter((r) => !r.migrated);
    for (const f of failed) {
      params.log.warn(`[state-db] Session migration failed for agent ${f.agent}: ${f.error}`);
    }
  } catch (err) {
    params.log.warn(`[state-db] Session JSON→SQLite migration failed: ${String(err)}`);
  }

  // One-shot migration: delivery queue JSON files → SQLite.
  try {
    const { migrateDeliveryQueueToSqlite } =
      await import("../infra/outbound/delivery-queue-migrate.js");
    const result = migrateDeliveryQueueToSqlite();
    if (result.pendingCount > 0 || result.failedCount > 0) {
      params.log.info(
        `[state-db] Migrated delivery queue: ${result.pendingCount} pending, ${result.failedCount} failed entries`,
      );
    }
    if (!result.migrated) {
      params.log.warn(`[state-db] Delivery queue migration failed: ${result.error}`);
    }
  } catch (err) {
    params.log.warn(`[state-db] Delivery queue JSON→SQLite migration failed: ${String(err)}`);
  }

  // One-shot migration: teams.json → SQLite.
  try {
    const { migrateTeamStoreToSqlite } = await import("../teams/team-store-migrate.js");
    const result = migrateTeamStoreToSqlite();
    if (result.runsCount > 0) {
      params.log.info(
        `[state-db] Migrated teams: ${result.runsCount} runs, ${result.tasksCount} tasks, ${result.messagesCount} messages`,
      );
    }
    if (!result.migrated) {
      params.log.warn(`[state-db] Teams migration failed: ${result.error}`);
    }
  } catch (err) {
    params.log.warn(`[state-db] Teams JSON→SQLite migration failed: ${String(err)}`);
  }

  // One-shot migration: subagents/runs.json → SQLite.
  try {
    const { migrateSubagentRegistryToSqlite } =
      await import("../agents/subagent-registry-migrate.js");
    const result = migrateSubagentRegistryToSqlite();
    if (result.count > 0) {
      params.log.info(
        `[state-db] Migrated subagent registry: ${result.count} run(s) from JSON to SQLite`,
      );
    }
    if (result.error) {
      params.log.warn(`[state-db] Subagent registry migration failed: ${result.error}`);
    }
  } catch (err) {
    params.log.warn(`[state-db] Subagent registry JSON→SQLite migration failed: ${String(err)}`);
  }

  // One-shot migration: Phase 3 stores (auth profiles, pairing, allowlists, thread bindings) → SQLite.
  try {
    const { migratePhase3ToSqlite } = await import("../infra/state-db/migrate-phase3.js");
    const results = migratePhase3ToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries from JSON to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(`[state-db] Phase 3 JSON→SQLite migration failed: ${String(err)}`);
  }

  // One-shot migration: Phase 4A cron stores (jobs.json, runs/*.jsonl) → SQLite.
  try {
    const { migrateCronToSqlite } = await import("../infra/state-db/migrate-cron.js");
    const results = migrateCronToSqlite(params.cfg.cron?.store);
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries from JSON to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(`[state-db] Phase 4A cron JSON→SQLite migration failed: ${String(err)}`);
  }

  // One-shot migration: Phase 4B core settings JSON files → SQLite.
  try {
    const { migrateCoreSettingsToSqlite } =
      await import("../infra/state-db/migrate-core-settings.js");
    const results = migrateCoreSettingsToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    if (migrated.length > 0) {
      params.log.info(
        `[state-db] Migrated core settings: ${migrated.map((r) => r.store).join(", ")}`,
      );
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(
      `[state-db] Phase 4B core settings JSON→SQLite migration failed: ${String(err)}`,
    );
  }

  // One-shot migration: Phase 4C channel state + credentials JSON files → SQLite.
  try {
    const { migrateChannelStateToSqlite } =
      await import("../infra/state-db/migrate-channel-state.js");
    const results = migrateChannelStateToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries from JSON to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(
      `[state-db] Phase 4C channel state JSON→SQLite migration failed: ${String(err)}`,
    );
  }

  // One-shot migration: Phase 5A device/node pairing JSON files → SQLite.
  try {
    const { migratePhase5aToSqlite } = await import("../infra/state-db/migrate-phase5a.js");
    const results = migratePhase5aToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries from JSON to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(
      `[state-db] Phase 5A device/node pairing JSON→SQLite migration failed: ${String(err)}`,
    );
  }

  // One-shot migration: Phase 5B sandbox registry JSON files → SQLite.
  try {
    const { migratePhase5bToSqlite } = await import("../infra/state-db/migrate-phase5b.js");
    const results = migratePhase5bToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries from JSON to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(
      `[state-db] Phase 5B sandbox registry JSON→SQLite migration failed: ${String(err)}`,
    );
  }

  // One-shot migration: Phase 5C node-host config JSON file → SQLite.
  try {
    const { migratePhase5cToSqlite } = await import("../infra/state-db/migrate-phase5c.js");
    const results = migratePhase5cToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries from JSON to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(
      `[state-db] Phase 5C node-host config JSON→SQLite migration failed: ${String(err)}`,
    );
  }

  // One-shot migration: Phase 6A gateway config (openclaw.json) → SQLite.
  // NOTE: this migration runs AFTER initStateDb() (above) and AFTER loadConfig() in run.ts.
  // The DB is already initialized; this deletes the JSON file so future reads use SQLite.
  try {
    const { migratePhase6aToSqlite } = await import("../infra/state-db/migrate-phase6a.js");
    const results = migratePhase6aToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} config to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(
      `[state-db] Phase 6A gateway config JSON→SQLite migration failed: ${String(err)}`,
    );
  }

  // One-shot migration: Phase 4D workspace/security JSON files → SQLite.
  try {
    const { migratePhase4dToSqlite } = await import("../infra/state-db/migrate-phase4d.js");
    const results = migratePhase4dToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries from JSON to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(
      `[state-db] Phase 4D workspace/security JSON→SQLite migration failed: ${String(err)}`,
    );
  }

  // One-shot migration: Phase 4E/5D MCP registries + agent registries → SQLite.
  try {
    const { migratePhase4e5dToSqlite } = await import("../infra/state-db/migrate-phase4e5d.js");
    const results = migratePhase4e5dToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(
      `[state-db] Phase 4E/5D registries JSON→SQLite migration failed: ${String(err)}`,
    );
  }

  // One-shot migration: Phase 5D-locks agents-lock.yaml → SQLite.
  try {
    const { migratePhase5dLocksToSqlite } =
      await import("../infra/state-db/migrate-phase5d-locks.js");
    const result = migratePhase5dLocksToSqlite();
    if (result.migrated && result.count > 0) {
      params.log.info(`[state-db] Migrated ${result.store}: ${result.count} entries to SQLite`);
    }
    if (result.error) {
      params.log.warn(`[state-db] ${result.store} migration failed: ${result.error}`);
    }
  } catch (err) {
    params.log.warn(`[state-db] Phase 5D agent-locks YAML→SQLite migration failed: ${String(err)}`);
  }

  // One-shot migration: Phase 8.5 PROJECTS.md → SQLite.
  try {
    const { migratePhase8ToSqlite } = await import("../infra/state-db/migrate-phase8.js");
    const results = migratePhase8ToSqlite();
    const migrated = results.filter((r) => r.migrated && r.count > 0);
    for (const r of migrated) {
      params.log.info(`[state-db] Migrated ${r.store}: ${r.count} entries to SQLite`);
    }
    const failed = results.filter((r) => r.error);
    for (const r of failed) {
      params.log.warn(`[state-db] ${r.store} migration failed: ${r.error}`);
    }
  } catch (err) {
    params.log.warn(`[state-db] Phase 8.5 PROJECTS.md→SQLite migration failed: ${String(err)}`);
  }

  try {
    const stateDir = resolveStateDir(process.env);
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

  // Reconcile YAML agent manifests with config agents.list on startup
  void reconcileAgentConfigOnStartup({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`agent config reconciliation failed: ${String(err)}`);
  });

  void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
  });

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  // Fire a startup heartbeat so agents can resume pending work immediately
  // instead of waiting for the next scheduled interval (STARTUP_DELAY_MS = 10s).
  setTimeout(() => {
    requestHeartbeatNow({ reason: "startup" });
  }, 5_000);

  return { browserControl, pluginServices };
}
