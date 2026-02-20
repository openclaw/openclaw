import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { buildAuthHealthSummary, formatRemainingShort } from "../agents/auth-health.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
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
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * Proactive auth health check on Gateway startup.
 * Validates all auth profiles and attempts to refresh expired OAuth tokens
 * before the first API call, avoiding latency on the first request.
 */
async function checkAndRefreshAuthOnStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  const summary = buildAuthHealthSummary({ store, cfg: params.cfg });

  const profileCount = summary.profiles.length;
  if (profileCount === 0) {
    params.log.info("startup auth check: no auth profiles configured");
    return;
  }

  const expired = summary.profiles.filter((p) => p.status === "expired");
  const expiring = summary.profiles.filter((p) => p.status === "expiring");
  const ok = summary.profiles.filter((p) => p.status === "ok" || p.status === "static");

  // OAuth profiles with refresh tokens report status "ok" even when the access
  // token has expired (they auto-renew on first API call).  Identify these so
  // we can proactively refresh them and avoid first-request latency.
  const oauthNeedsRefresh = summary.profiles.filter(
    (p) =>
      p.type === "oauth" &&
      p.status !== "expired" &&
      p.remainingMs !== undefined &&
      p.remainingMs <= 0,
  );

  params.log.info(
    `startup auth check: ${profileCount} profiles — ${ok.length} ok, ${expiring.length} expiring, ${expired.length} expired` +
      (oauthNeedsRefresh.length > 0
        ? `, ${oauthNeedsRefresh.length} oauth needing refresh`
        : ""),
  );

  for (const profile of expiring) {
    const remaining = formatRemainingShort(profile.remainingMs);
    params.log.warn(
      `auth profile "${profile.profileId}" (${profile.provider}) expiring in ${remaining}`,
    );
  }

  // Proactively refresh expired or access-token-expired OAuth tokens so the
  // first API call doesn't block.
  const refreshCandidates = [...expired, ...oauthNeedsRefresh];
  for (const profile of refreshCandidates) {
    if (profile.type !== "oauth") {
      params.log.warn(
        `auth profile "${profile.profileId}" (${profile.provider}) is expired (type=${profile.type}, no auto-refresh)`,
      );
      continue;
    }
    params.log.warn(
      `auth profile "${profile.profileId}" (${profile.provider}) expired — attempting proactive refresh`,
    );
    try {
      const refreshed = await resolveApiKeyForProfile({
        cfg: params.cfg,
        store,
        profileId: profile.profileId,
      });
      if (refreshed) {
        params.log.info(
          `auth profile "${profile.profileId}" refreshed successfully`,
        );
      } else {
        params.log.warn(
          `auth profile "${profile.profileId}" refresh returned null — may need re-authentication`,
        );
      }
    } catch (err) {
      params.log.warn(
        `auth profile "${profile.profileId}" refresh failed: ${String(err)}`,
      );
    }
  }
}

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
  } catch (err) {
    params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
  }

  // Proactive auth health check: validate and refresh tokens before accepting requests.
  try {
    await checkAndRefreshAuthOnStartup({
      cfg: params.cfg,
      log: {
        info: (msg) => params.log.warn(msg), // use warn level for visibility in logs
        warn: (msg) => params.log.warn(msg),
      },
    });
  } catch (err) {
    params.log.warn(`startup auth check failed: ${String(err)}`);
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
