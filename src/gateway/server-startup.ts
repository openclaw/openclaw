import fs from "node:fs/promises";
import path from "node:path";
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
import { updateSessionStore } from "../config/sessions.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { isTranscriptEmptyShell } from "../sessions/archive-service.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";
import { consumeGatewayShutdownState, USER_ARCHIVE_SHUTDOWN_REASON } from "./shutdown-state.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;
const USER_ARCHIVE_EMPTY_SHELL_MAX_AGE_MS = 2 * 60 * 1000;

async function pruneUserArchiveEmptySessionShells(params: {
  sessionDirs: string[];
  shutdownAt: number;
  log: { warn: (msg: string) => void };
}) {
  const now = Date.now();
  const deletedByDir = new Map<string, Set<string>>();
  for (const sessionsDir of params.sessionDirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const entryName of entries) {
      if (!entryName.endsWith(".jsonl")) {
        continue;
      }
      if (
        entryName.includes(".reset.") ||
        entryName.includes(".deleted.") ||
        entryName.includes(".bak.")
      ) {
        continue;
      }
      const transcriptPath = path.join(sessionsDir, entryName);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(transcriptPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const ageMs = now - stat.mtimeMs;
      const createdAfterArchive = stat.mtimeMs >= params.shutdownAt - 1000;
      if (!createdAfterArchive || ageMs > USER_ARCHIVE_EMPTY_SHELL_MAX_AGE_MS) {
        continue;
      }
      const isEmptyShell = await isTranscriptEmptyShell(transcriptPath);
      if (!isEmptyShell) {
        continue;
      }
      await fs.rm(transcriptPath, { force: true }).catch(() => undefined);
      const deleted = deletedByDir.get(sessionsDir) ?? new Set<string>();
      deleted.add(entryName);
      deletedByDir.set(sessionsDir, deleted);
    }
  }
  for (const [sessionsDir, deletedFiles] of deletedByDir) {
    if (deletedFiles.size === 0) {
      continue;
    }
    const storePath = path.join(sessionsDir, "sessions.json");
    await updateSessionStore(storePath, (store) => {
      for (const [key, entry] of Object.entries(store)) {
        const sessionFileName = entry.sessionFile
          ? path.basename(entry.sessionFile)
          : `${entry.sessionId}.jsonl`;
        if (!deletedFiles.has(sessionFileName)) {
          continue;
        }
        delete store[key];
      }
    }).catch(() => undefined);
    params.log.warn(
      `pruned ${deletedFiles.size} empty session shell${deletedFiles.size === 1 ? "" : "s"} after user-archive shutdown in ${sessionsDir}`,
    );
  }
}

export const __testing = {
  pruneUserArchiveEmptySessionShells,
};

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
    const previousShutdown = await consumeGatewayShutdownState();
    if (
      previousShutdown?.reason === USER_ARCHIVE_SHUTDOWN_REASON &&
      typeof previousShutdown.at === "number" &&
      Number.isFinite(previousShutdown.at) &&
      previousShutdown.at > 0
    ) {
      // user-archive intentionally ends the run; if startup briefly created a
      // new session shell but it still has no user/assistant turns, we can
      // remove it safely to avoid polluting session history with empty shells.
      await pruneUserArchiveEmptySessionShells({
        sessionDirs,
        shutdownAt: previousShutdown.at,
        log: params.log,
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

  void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
  });

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  return { browserControl, pluginServices };
}
