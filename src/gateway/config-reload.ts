// Gateway config hot-reload watcher.
// Diffs config/plugin install snapshots and dispatches hot reload or restart plans.
import nodePath from "node:path";
import chokidar from "chokidar";
import type { ConfigWriteNotification } from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
} from "../plugins/installed-plugin-index-records.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  resolveConfigReloadMetadata,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import type { GatewayHotReloadStatus } from "./config-reload-status.types.js";

export {
  buildGatewayReloadPlan,
  diffConfigPaths,
  listPluginInstallTimestampMetadataPaths,
  listPluginInstallWholeRecordPaths,
  resolveConfigReloadMetadata,
  resolveGatewayReloadSettings,
};
export type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;

// Watcher 'error' events (for example EMFILE/ENOSPC inotify exhaustion) close
// the chokidar watcher. Re-create it with bounded backoff so a transient fault
// does not permanently kill config hot-reload. If all native retries are
// exhausted (typical when the host has insufficient inotify watches), fall
// back to polling mode before giving up entirely.
const WATCHER_RECREATE_MAX_RETRIES = 3;
const WATCHER_RECREATE_BACKOFF_MS = [500, 2000, 5000] as const;

function resolveChokidarUsePolling(degradedToPolling: boolean): boolean {
  const envPoll = process.env.CHOKIDAR_USEPOLLING;
  if (envPoll !== undefined) {
    const envLower = envPoll.toLowerCase();
    if (envLower === "false" || envLower === "0") {
      return false;
    }
    if (envLower === "true" || envLower === "1") {
      return true;
    }
    return Boolean(envLower);
  }
  return Boolean(process.env.VITEST) || degradedToPolling;
}

/**
 * Paths under `skills.*` always change the snapshot that sessions cache in
 * sessions.json. Any prefix match here (for example `skills.allowBundled`,
 * `skills.entries.X.enabled`, `skills.profile`) forces sessions to rebuild
 * their snapshot on the next turn rather than silently advertising stale
 * tools to the model.
 */
const SKILLS_INVALIDATION_PREFIXES = ["skills"] as const;

function matchesSkillsInvalidationPrefix(path: string): boolean {
  return SKILLS_INVALIDATION_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
}

function firstSkillsChangedPath(changedPaths: string[]): string | undefined {
  return changedPaths.find(matchesSkillsInvalidationPrefix);
}

function isNoopReloadPlan(plan: GatewayReloadPlan): boolean {
  return (
    !plan.restartGateway &&
    plan.hotReasons.length === 0 &&
    !plan.reloadHooks &&
    !plan.restartGmailWatcher &&
    !plan.restartCron &&
    !plan.restartHeartbeat &&
    !plan.restartHealthMonitor &&
    !plan.reloadPlugins &&
    !plan.disposeMcpRuntimes &&
    plan.restartChannels.size === 0
  );
}

type GatewayConfigReloader = {
  stop: () => Promise<void>;
  hotReloadStatus: () => GatewayHotReloadStatus;
};

type PluginInstallRecords = Record<string, PluginInstallRecord>;

type ConfigReloadGeneration = Readonly<{
  config: OpenClawConfig;
  compareConfig: OpenClawConfig;
  pluginInstallRecords: PluginInstallRecords;
}>;

type ConfigReloadDisposition = "applied" | "ignored" | "restart-pending";

function asPluginInstallConfig(records: PluginInstallRecords): OpenClawConfig {
  return {
    plugins: {
      installs: records,
    },
  };
}

export function startGatewayConfigReloader(opts: {
  initialConfig: OpenClawConfig;
  initialCompareConfig?: OpenClawConfig;
  initialInternalWriteHash?: string | null;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  onConfigChange?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  onConfigApplied?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  onNoopConfigCommit: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  onHotReload: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  onRestart: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  promoteSnapshot?: (snapshot: ConfigFileSnapshot, reason: string) => Promise<boolean>;
  initialPluginInstallRecords?: PluginInstallRecords;
  readPluginInstallRecords?: () => Promise<PluginInstallRecords>;
  subscribeToWrites?: (listener: (event: ConfigWriteNotification) => void) => () => void;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath: string;
  watchParentDirectory?: boolean;
}): GatewayConfigReloader {
  let appliedGeneration: ConfigReloadGeneration = {
    config: opts.initialConfig,
    compareConfig: opts.initialCompareConfig ?? opts.initialConfig,
    pluginInstallRecords:
      opts.initialPluginInstallRecords ?? loadInstalledPluginIndexInstallRecordsSync(),
  };
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let restartQueued = false;
  let restartRetryPending = false;
  let missingConfigRetries = 0;
  let pendingInProcessConfig: {
    config: OpenClawConfig;
    compareConfig: OpenClawConfig;
    persistedHash: string;
    afterWrite?: ConfigWriteNotification["afterWrite"];
  } | null = null;
  let lastHandledWriteHash = opts.initialInternalWriteHash ?? null;
  const readPluginInstallRecords =
    opts.readPluginInstallRecords ?? loadInstalledPluginIndexInstallRecords;

  const scheduleAfter = (wait: number) => {
    if (stopped) {
      return;
    }
    // Coalesce filesystem/write-listener bursts into one reload pass. Config
    // writes often touch temp and final paths in quick succession.
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void runReload();
    }, wait);
  };
  const schedule = () => {
    scheduleAfter(resolveGatewayReloadSettings(appliedGeneration.config).debounceMs);
  };
  const queueRestart = (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
    if (restartQueued) {
      // A newer desired generation arrived while restart preflight was still
      // running. Retain one retry so a rejected preflight cannot lose it.
      restartRetryPending = true;
      return;
    }
    restartQueued = true;
    void (async () => {
      try {
        await opts.onRestart(plan, nextConfig);
      } catch (err) {
        // Restart checks can fail (for example unresolved SecretRefs). Keep the
        // reloader alive and retry a newer generation that arrived meanwhile.
        restartQueued = false;
        opts.log.error(`config restart failed: ${String(err)}`);
        if (restartRetryPending) {
          restartRetryPending = false;
          scheduleAfter(0);
        }
      }
    })();
  };

  const handleMissingSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.exists) {
      missingConfigRetries = 0;
      return false;
    }
    if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
      missingConfigRetries += 1;
      opts.log.info(
        `config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`,
      );
      scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
      return true;
    }
    opts.log.warn("config reload skipped (config file not found)");
    return true;
  };

  const handleInvalidSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.valid) {
      return false;
    }
    const issues = formatConfigIssueLines(snapshot.issues, "").join(", ");
    opts.log.warn(`config reload skipped (invalid config): ${issues}`);
    return true;
  };

  const applySnapshot = async (
    nextConfig: OpenClawConfig,
    nextCompareConfig: OpenClawConfig,
    afterWrite?: ConfigWriteNotification["afterWrite"],
  ): Promise<ConfigReloadDisposition> => {
    const applied = appliedGeneration;
    const configChangedPaths = diffConfigPaths(applied.compareConfig, nextCompareConfig);
    const configPluginInstallTimestampNoopPaths = listPluginInstallTimestampMetadataPaths(
      applied.compareConfig,
      nextCompareConfig,
    );
    const configPluginInstallWholeRecordPaths = listPluginInstallWholeRecordPaths(
      applied.compareConfig,
      nextCompareConfig,
    );
    let nextPluginInstallRecords = applied.pluginInstallRecords;
    try {
      nextPluginInstallRecords = await readPluginInstallRecords();
    } catch (err) {
      opts.log.warn(`config reload plugin install record check failed: ${String(err)}`);
    }
    const previousPluginInstallConfig = asPluginInstallConfig(applied.pluginInstallRecords);
    const nextPluginInstallConfig = asPluginInstallConfig(nextPluginInstallRecords);
    const pluginInstallRecordChangedPaths = diffConfigPaths(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const pluginInstallRecordTimestampNoopPaths = listPluginInstallTimestampMetadataPaths(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const pluginInstallRecordWholeRecordPaths = listPluginInstallWholeRecordPaths(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const changedPaths = [...configChangedPaths, ...pluginInstallRecordChangedPaths];
    const pluginInstallTimestampNoopPaths = [
      ...configPluginInstallTimestampNoopPaths,
      ...pluginInstallRecordTimestampNoopPaths,
    ];
    const pluginInstallWholeRecordPaths = [
      ...configPluginInstallWholeRecordPaths,
      ...pluginInstallRecordWholeRecordPaths,
    ];
    const nextGeneration: ConfigReloadGeneration = {
      config: nextConfig,
      compareConfig: nextCompareConfig,
      pluginInstallRecords: nextPluginInstallRecords,
    };
    const commitAppliedGeneration = (): ConfigReloadDisposition => {
      appliedGeneration = nextGeneration;
      // Sessions must only discard their cached skills after the corresponding
      // runtime generation is accepted, never for rejected or ignored config.
      const skillsChangedPath = firstSkillsChangedPath(changedPaths);
      if (skillsChangedPath !== undefined) {
        bumpSkillsSnapshotVersion({ reason: "config-change", changedPath: skillsChangedPath });
        opts.log.info(`skills snapshot invalidated by config change (${skillsChangedPath})`);
      }
      return "applied";
    };
    if (changedPaths.length === 0) {
      return commitAppliedGeneration();
    }

    const followUp = resolveConfigWriteFollowUp(afterWrite);
    const nextSettings = resolveGatewayReloadSettings(nextConfig);
    opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
    if (followUp.mode === "none") {
      opts.log.info(`config reload skipped by writer intent (${followUp.reason})`);
      return commitAppliedGeneration();
    }
    const plan = buildGatewayReloadPlan(changedPaths, {
      noopPaths: pluginInstallTimestampNoopPaths,
      forceChangedPaths: pluginInstallWholeRecordPaths,
    });
    if (nextSettings.mode === "off") {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      return "ignored";
    }
    if (isNoopReloadPlan(plan) && !followUp.requiresRestart) {
      await opts.onConfigChange?.(plan, nextConfig);
      // No-op plans still change the runtime config snapshot. Commit before
      // marking applied so getRuntimeConfig() readers do not stay stale until restart.
      await opts.onNoopConfigCommit(plan, nextConfig);
      await opts.onConfigApplied?.(plan, nextConfig);
      return commitAppliedGeneration();
    }
    if (followUp.requiresRestart) {
      const restartPlan = {
        ...plan,
        restartGateway: true,
        restartReasons: [...plan.restartReasons, followUp.reason],
      };
      await opts.onConfigChange?.(restartPlan, nextConfig);
      queueRestart(restartPlan, nextConfig);
      return "restart-pending";
    }
    if (nextSettings.mode === "restart") {
      await opts.onConfigChange?.({ ...plan, restartGateway: true }, nextConfig);
      queueRestart(plan, nextConfig);
      return "restart-pending";
    }
    if (plan.restartGateway) {
      if (nextSettings.mode === "hot") {
        opts.log.warn(
          `config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(
            ", ",
          )})`,
        );
        return "ignored";
      }
      await opts.onConfigChange?.(plan, nextConfig);
      queueRestart(plan, nextConfig);
      return "restart-pending";
    }

    await opts.onConfigChange?.(plan, nextConfig);
    await opts.onHotReload(plan, nextConfig);
    await opts.onConfigApplied?.(plan, nextConfig);
    return commitAppliedGeneration();
  };

  const promoteAcceptedSnapshot = async (snapshot: ConfigFileSnapshot, reason: string) => {
    if (!opts.promoteSnapshot || !snapshot.exists || !snapshot.valid) {
      return;
    }
    try {
      await opts.promoteSnapshot(snapshot, reason);
    } catch (err) {
      opts.log.warn(`config reload last-known-good promotion failed: ${String(err)}`);
    }
  };

  const promoteAcceptedInProcessWrite = async (persistedHash: string) => {
    if (!opts.promoteSnapshot) {
      return;
    }
    try {
      const snapshot = await opts.readSnapshot();
      if (snapshot.hash !== persistedHash || !snapshot.valid) {
        return;
      }
      await promoteAcceptedSnapshot(snapshot, "in-process-write");
    } catch (err) {
      opts.log.warn(`config reload in-process last-known-good promotion failed: ${String(err)}`);
    }
  };

  const runReload = async () => {
    if (stopped) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      if (pendingInProcessConfig) {
        const pendingWrite = pendingInProcessConfig;
        pendingInProcessConfig = null;
        missingConfigRetries = 0;
        const disposition = await applySnapshot(
          pendingWrite.config,
          pendingWrite.compareConfig,
          pendingWrite.afterWrite,
        );
        if (disposition !== "restart-pending") {
          lastHandledWriteHash = pendingWrite.persistedHash;
        }
        if (disposition === "applied") {
          await promoteAcceptedInProcessWrite(pendingWrite.persistedHash);
        }
        return;
      }
      const snapshot = await opts.readSnapshot();
      if (lastHandledWriteHash && typeof snapshot.hash === "string") {
        if (snapshot.hash === lastHandledWriteHash) {
          return;
        }
        lastHandledWriteHash = null;
      }
      if (handleMissingSnapshot(snapshot)) {
        return;
      }
      if (!snapshot.valid) {
        handleInvalidSnapshot(snapshot);
        return;
      }
      const disposition = await applySnapshot(snapshot.config, snapshot.sourceConfig);
      if (disposition === "applied") {
        await promoteAcceptedSnapshot(snapshot, "valid-config");
      }
    } catch (err) {
      opts.log.error(`config reload failed: ${String(err)}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const scheduleFromWatcher = (_changedPath: string) => {
    schedule();
  };

  const unsubscribeFromWrites =
    opts.subscribeToWrites?.((event) => {
      if (event.configPath !== opts.watchPath) {
        return;
      }
      pendingInProcessConfig = {
        config: event.runtimeConfig,
        compareConfig: event.sourceConfig,
        persistedHash: event.persistedHash,
        afterWrite: event.afterWrite,
      };
      scheduleAfter(0);
    }) ?? (() => {});

  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  let watcherRecreateRetries = 0;
  let watcherRecreateTimer: ReturnType<typeof setTimeout> | null = null;
  let hotReloadStatus: GatewayHotReloadStatus = "active";
  let degradedToPolling = false;
  let watcherUsesPolling = false;

  const createWatcher = () => {
    if (stopped) {
      return;
    }
    const usePolling = resolveChokidarUsePolling(degradedToPolling);
    // Projected-volume updates retarget a sibling such as `..data` without
    // changing the configured symlink. Watch both paths so those swaps and
    // direct changes through externally managed symlinks both reconcile.
    const watchTarget = opts.watchParentDirectory
      ? [opts.watchPath, nodePath.dirname(opts.watchPath)]
      : opts.watchPath;
    const next = chokidar.watch(watchTarget, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ...(opts.watchParentDirectory ? { depth: 0 } : {}),
      usePolling,
    });
    next.on("add", scheduleFromWatcher);
    next.on("addDir", scheduleFromWatcher);
    next.on("change", scheduleFromWatcher);
    next.on("unlink", scheduleFromWatcher);
    next.on("unlinkDir", scheduleFromWatcher);
    next.on("ready", () => {
      if (!stopped && watcher === next) {
        watcherRecreateRetries = 0;
      }
    });
    next.on("error", (err) => {
      handleWatcherError(next, err);
    });
    watcher = next;
    watcherUsesPolling = next.options.usePolling;
    hotReloadStatus = "active";
  };

  const handleWatcherError = (source: typeof watcher, err: unknown) => {
    // Ignore stale errors from a watcher we already replaced or stopped.
    if (stopped || source !== watcher) {
      return;
    }
    const failedWatcherUsedPolling = watcherUsesPolling;
    watcher = null;
    watcherUsesPolling = false;
    void source?.close().catch(() => {});
    if (watcherRecreateRetries >= WATCHER_RECREATE_MAX_RETRIES) {
      // All native (inotify/kqueue) retries exhausted — fall back to polling
      // mode so config hot-reload survives on hosts where inotify resources
      // are constrained (e.g. low fs.inotify.max_user_watches).
      if (!failedWatcherUsedPolling && resolveChokidarUsePolling(true)) {
        degradedToPolling = true;
        watcherRecreateRetries = 0;
        opts.log.warn(
          `config watcher native retries exhausted; degrading to polling mode: ${String(err)}`,
        );
        watcherRecreateTimer = setTimeout(() => {
          watcherRecreateTimer = null;
          createWatcher();
        }, WATCHER_RECREATE_BACKOFF_MS[0] ?? 500);
        return;
      }
      const mode = failedWatcherUsedPolling ? "polling mode" : "native mode";
      hotReloadStatus = "disabled";
      opts.log.error(
        `config hot-reload disabled: watcher failed after ${WATCHER_RECREATE_MAX_RETRIES} re-create attempts in ${mode}: ${String(err)}`,
      );
      return;
    }
    const backoff =
      WATCHER_RECREATE_BACKOFF_MS[watcherRecreateRetries] ??
      WATCHER_RECREATE_BACKOFF_MS[WATCHER_RECREATE_BACKOFF_MS.length - 1] ??
      0;
    watcherRecreateRetries += 1;
    opts.log.warn(
      `config watcher error; re-creating watcher (attempt ${watcherRecreateRetries}/${WATCHER_RECREATE_MAX_RETRIES} in ${backoff}ms): ${String(err)}`,
    );
    watcherRecreateTimer = setTimeout(() => {
      watcherRecreateTimer = null;
      createWatcher();
    }, backoff);
  };

  createWatcher();

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = null;
      if (watcherRecreateTimer) {
        clearTimeout(watcherRecreateTimer);
        watcherRecreateTimer = null;
      }
      unsubscribeFromWrites();
      const active = watcher;
      watcher = null;
      await active?.close().catch(() => {});
    },
    hotReloadStatus: () => hotReloadStatus,
  };
}
