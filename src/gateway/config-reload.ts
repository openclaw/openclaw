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

// Hot-reload stays "active" while a watcher is live. It flips to "disabled" only
// after watcher re-creation fails past the retry budget, so operators/callers
// can detect silent degradation instead of assuming reloads still fire.
export type GatewayHotReloadStatus = "active" | "disabled";

type GatewayConfigReloader = {
  stop: () => Promise<void>;
  hotReloadStatus: () => GatewayHotReloadStatus;
};

type PluginInstallRecords = Record<string, PluginInstallRecord>;

type ConfigReloadSnapshotReadResult =
  | ConfigFileSnapshot
  | {
      snapshot: ConfigFileSnapshot;
      includeFilePaths?: readonly string[];
    };

function unpackConfigReloadSnapshot(result: ConfigReloadSnapshotReadResult): {
  snapshot: ConfigFileSnapshot;
  includeFilePaths?: readonly string[];
} {
  return "snapshot" in result ? result : { snapshot: result };
}

function normalizeIncludeWatcherPaths(
  rootPath: string,
  includeFilePaths: readonly string[] = [],
): string[] {
  const normalizedRoot = nodePath.normalize(rootPath);
  const includes = new Set(
    includeFilePaths.map((includePath) => nodePath.normalize(includePath)).filter(Boolean),
  );
  includes.delete(normalizedRoot);
  return [...includes].toSorted((left, right) => left.localeCompare(right));
}

function watcherPathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

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
  initialIncludeFilePaths?: readonly string[];
  readSnapshot: () => Promise<ConfigReloadSnapshotReadResult>;
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
}): GatewayConfigReloader {
  let currentConfig = opts.initialConfig;
  let currentCompareConfig = opts.initialCompareConfig ?? opts.initialConfig;
  let settings = resolveGatewayReloadSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let pendingIncludeReload = false;
  let restartQueued = false;
  let missingConfigRetries = 0;
  let pendingInProcessConfig: {
    config: OpenClawConfig;
    compareConfig: OpenClawConfig;
    persistedHash: string;
    afterWrite?: ConfigWriteNotification["afterWrite"];
  } | null = null;
  let lastAppliedWriteHash = opts.initialInternalWriteHash ?? null;
  let currentApplyRejected = false;
  let currentPluginInstallRecords =
    opts.initialPluginInstallRecords ?? loadInstalledPluginIndexInstallRecordsSync();
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
    scheduleAfter(settings.debounceMs);
  };
  const queueRestart = (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
    if (restartQueued) {
      return;
    }
    restartQueued = true;
    void (async () => {
      try {
        await opts.onRestart(plan, nextConfig);
      } catch (err) {
        // Restart checks can fail (for example unresolved SecretRefs). Keep the
        // reloader alive and allow a future change to retry restart scheduling.
        restartQueued = false;
        opts.log.error(`config restart failed: ${String(err)}`);
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
  ) => {
    const configChangedPaths = diffConfigPaths(currentCompareConfig, nextCompareConfig);
    const configPluginInstallTimestampNoopPaths = listPluginInstallTimestampMetadataPaths(
      currentCompareConfig,
      nextCompareConfig,
    );
    const configPluginInstallWholeRecordPaths = listPluginInstallWholeRecordPaths(
      currentCompareConfig,
      nextCompareConfig,
    );
    let nextPluginInstallRecords = currentPluginInstallRecords;
    try {
      nextPluginInstallRecords = await readPluginInstallRecords();
    } catch (err) {
      opts.log.warn(`config reload plugin install record check failed: ${String(err)}`);
    }
    const previousPluginInstallConfig = asPluginInstallConfig(currentPluginInstallRecords);
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
    currentConfig = nextConfig;
    currentCompareConfig = nextCompareConfig;
    currentPluginInstallRecords = nextPluginInstallRecords;
    settings = resolveGatewayReloadSettings(nextConfig);
    if (changedPaths.length === 0) {
      if (currentApplyRejected) {
        opts.log.warn("config reload skipped (previous apply failed; waiting for config change)");
        return false;
      }
      return true;
    }

    // Invalidate cached skills snapshots (persisted in sessions.json) whenever
    // the user touches skills.* config. Without this, sessions keep advertising
    // tools that no longer exist in the allowlist, which causes infinite
    // tool-not-found loops against the model.
    const skillsChangedPath = firstSkillsChangedPath(changedPaths);
    if (skillsChangedPath !== undefined) {
      bumpSkillsSnapshotVersion({ reason: "config-change", changedPath: skillsChangedPath });
      opts.log.info(`skills snapshot invalidated by config change (${skillsChangedPath})`);
    }

    const followUp = resolveConfigWriteFollowUp(afterWrite);
    opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
    if (followUp.mode === "none") {
      opts.log.info(`config reload skipped by writer intent (${followUp.reason})`);
      currentApplyRejected = false;
      return true;
    }
    const plan = buildGatewayReloadPlan(changedPaths, {
      noopPaths: pluginInstallTimestampNoopPaths,
      forceChangedPaths: pluginInstallWholeRecordPaths,
    });
    if (isNoopReloadPlan(plan) && !followUp.requiresRestart) {
      currentApplyRejected = false;
      return true;
    }
    if (settings.mode === "off") {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      currentApplyRejected = false;
      return true;
    }
    if (followUp.requiresRestart) {
      queueRestart(
        {
          ...plan,
          restartGateway: true,
          restartReasons: [...plan.restartReasons, followUp.reason],
        },
        nextConfig,
      );
      currentApplyRejected = false;
      return true;
    }
    if (settings.mode === "restart") {
      queueRestart(plan, nextConfig);
      currentApplyRejected = false;
      return true;
    }
    if (plan.restartGateway) {
      if (settings.mode === "hot") {
        opts.log.warn(
          `config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(
            ", ",
          )})`,
        );
        currentApplyRejected = false;
        return true;
      }
      queueRestart(plan, nextConfig);
      currentApplyRejected = false;
      return true;
    }

    try {
      await opts.onHotReload(plan, nextConfig);
      currentApplyRejected = false;
      return true;
    } catch (err) {
      currentApplyRejected = true;
      opts.log.error(`config reload failed: ${String(err)}`);
      return false;
    }
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

  const promoteAcceptedInProcessWrite = async (
    persistedHash: string,
    acceptedCompareConfig: OpenClawConfig,
  ) => {
    if (!opts.promoteSnapshot) {
      return;
    }
    try {
      const snapshotRead = unpackConfigReloadSnapshot(await opts.readSnapshot());
      const snapshot = snapshotRead.snapshot;
      if (
        snapshot.hash !== persistedHash ||
        !snapshot.valid ||
        diffConfigPaths(acceptedCompareConfig, snapshot.sourceConfig).length > 0
      ) {
        return;
      }
      if (snapshotRead.includeFilePaths) {
        replaceWatchedPaths(snapshotRead.includeFilePaths);
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
        const applied = await applySnapshot(
          pendingWrite.config,
          pendingWrite.compareConfig,
          pendingWrite.afterWrite,
        );
        if (!applied) {
          if (lastAppliedWriteHash === pendingWrite.persistedHash) {
            lastAppliedWriteHash = null;
          }
          return;
        }
        await promoteAcceptedInProcessWrite(pendingWrite.persistedHash, pendingWrite.compareConfig);
        return;
      }
      const bypassRootWriteHashDedupe = pendingIncludeReload;
      pendingIncludeReload = false;
      const snapshotRead = unpackConfigReloadSnapshot(await opts.readSnapshot());
      const snapshot = snapshotRead.snapshot;
      if (lastAppliedWriteHash && typeof snapshot.hash === "string") {
        if (!bypassRootWriteHashDedupe && snapshot.hash === lastAppliedWriteHash) {
          return;
        }
        if (snapshot.hash !== lastAppliedWriteHash) {
          lastAppliedWriteHash = null;
        }
      }
      if (handleMissingSnapshot(snapshot)) {
        return;
      }
      if (!snapshot.valid) {
        handleInvalidSnapshot(snapshot);
        return;
      }
      const applied = await applySnapshot(snapshot.config, snapshot.sourceConfig);
      if (!applied) {
        return;
      }
      if (snapshotRead.includeFilePaths) {
        replaceWatchedPaths(snapshotRead.includeFilePaths);
      }
      await promoteAcceptedSnapshot(snapshot, "valid-config");
    } catch (err) {
      opts.log.error(`config reload failed: ${String(err)}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      } else if (pendingIncludeReload) {
        scheduleAfter(0);
      }
    }
  };

  const normalizedRootWatchPath = nodePath.normalize(opts.watchPath);
  const scheduleFromWatcher = (changedPath?: string) => {
    if (
      typeof changedPath === "string" &&
      nodePath.normalize(changedPath) !== normalizedRootWatchPath
    ) {
      pendingIncludeReload = true;
    }
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
      lastAppliedWriteHash = event.persistedHash;
      scheduleAfter(0);
    }) ?? (() => {});

  type ConfigWatcher = ReturnType<typeof chokidar.watch>;
  type IncludeWatcherGroup = {
    paths: string[];
    watchers: ConfigWatcher[];
    ready: Set<ConfigWatcher>;
    usePolling: boolean;
  };
  const emptyIncludeGroup = (paths: string[] = []): IncludeWatcherGroup => ({
    paths,
    watchers: [],
    ready: new Set(),
    usePolling: false,
  });

  let watcher: ConfigWatcher | null = null;
  let watcherRecreateRetries = 0;
  let watcherRecreateTimer: ReturnType<typeof setTimeout> | null = null;
  let rootHotReloadDisabled = false;
  let degradedToPolling = false;
  let watcherUsesPolling = false;

  const initialIncludePaths = normalizeIncludeWatcherPaths(
    opts.watchPath,
    opts.initialIncludeFilePaths,
  );
  let activeIncludeGroup = emptyIncludeGroup(initialIncludePaths);
  let pendingIncludeGroup: IncludeWatcherGroup | null = null;
  let desiredIncludePaths = initialIncludePaths;
  let includeGeneration = 0;
  let includeReplacementRetries = 0;
  let includeReplacementTimer: ReturnType<typeof setTimeout> | null = null;
  let includeHotReloadDisabled = false;
  let includeDegradedToPolling = false;

  const closeWatcher = (target: ConfigWatcher | null) => {
    void target?.close().catch(() => {});
  };

  const closeIncludeGroup = (group: IncludeWatcherGroup | null) => {
    for (const target of group?.watchers ?? []) {
      closeWatcher(target);
    }
  };

  const createWatcherInstance = (watchPath: string, usePolling: boolean): ConfigWatcher =>
    chokidar.watch(watchPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      usePolling,
    });

  const activateIncludeGroup = (group: IncludeWatcherGroup) => {
    if (stopped || group !== pendingIncludeGroup) {
      return;
    }
    const previous = activeIncludeGroup;
    activeIncludeGroup = group;
    pendingIncludeGroup = null;
    includeReplacementRetries = 0;
    includeHotReloadDisabled = false;
    closeIncludeGroup(previous);

    // Re-read once after the handoff so edits during candidate startup are
    // reconciled without opening a gap between the old and new exact sets.
    pendingIncludeReload = true;
    schedule();
  };

  const scheduleIncludeReplacementRetry = (
    generation: number,
    failedWithPolling: boolean,
    err: unknown,
  ) => {
    if (stopped || generation !== includeGeneration) {
      return;
    }
    if (includeReplacementRetries >= WATCHER_RECREATE_MAX_RETRIES) {
      if (!failedWithPolling && resolveChokidarUsePolling(true)) {
        includeDegradedToPolling = true;
        includeReplacementRetries = 0;
        opts.log.warn(
          `config include watcher native retries exhausted; degrading to polling mode: ${String(err)}`,
        );
        includeReplacementTimer = setTimeout(() => {
          includeReplacementTimer = null;
          stageIncludeReplacement(generation);
        }, WATCHER_RECREATE_BACKOFF_MS[0] ?? 500);
        return;
      }
      const mode = failedWithPolling ? "polling mode" : "native mode";
      includeHotReloadDisabled = true;
      opts.log.error(
        `config include hot-reload disabled: watcher failed after ${WATCHER_RECREATE_MAX_RETRIES} re-create attempts in ${mode}; keeping prior paths: ${String(err)}`,
      );
      return;
    }
    const backoff =
      WATCHER_RECREATE_BACKOFF_MS[includeReplacementRetries] ??
      WATCHER_RECREATE_BACKOFF_MS[WATCHER_RECREATE_BACKOFF_MS.length - 1] ??
      0;
    includeReplacementRetries += 1;
    opts.log.warn(
      `config include watcher error; retrying replacement (attempt ${includeReplacementRetries}/${WATCHER_RECREATE_MAX_RETRIES} in ${backoff}ms): ${String(err)}`,
    );
    includeReplacementTimer = setTimeout(() => {
      includeReplacementTimer = null;
      stageIncludeReplacement(generation);
    }, backoff);
  };

  const createIncludeGroup = (paths: string[], generation: number): IncludeWatcherGroup => {
    const usePolling = resolveChokidarUsePolling(includeDegradedToPolling);
    const group: IncludeWatcherGroup = {
      paths,
      watchers: [],
      ready: new Set(),
      usePolling: false,
    };
    try {
      for (const includePath of paths) {
        const next = createWatcherInstance(includePath, usePolling);
        group.watchers.push(next);
        group.usePolling ||= Boolean(next.options.usePolling);
        const scheduleIfActive = (changedPath: string) => {
          if (group === activeIncludeGroup) {
            scheduleFromWatcher(changedPath);
          }
        };
        next.on("add", scheduleIfActive);
        next.on("change", scheduleIfActive);
        next.on("unlink", scheduleIfActive);
        next.on("ready", () => {
          if (stopped) {
            return;
          }
          group.ready.add(next);
          if (group.ready.size !== group.watchers.length) {
            return;
          }
          if (group === pendingIncludeGroup) {
            if (generation !== includeGeneration) {
              return;
            }
            activateIncludeGroup(group);
          } else if (group === activeIncludeGroup) {
            pendingIncludeReload = true;
            schedule();
          }
        });
        next.on("error", (err) => {
          if (stopped) {
            return;
          }
          if (group === pendingIncludeGroup) {
            if (generation !== includeGeneration) {
              return;
            }
            pendingIncludeGroup = null;
            closeIncludeGroup(group);
            scheduleIncludeReplacementRetry(generation, group.usePolling, err);
            return;
          }
          if (group === activeIncludeGroup) {
            activeIncludeGroup = emptyIncludeGroup();
            closeIncludeGroup(group);
            if (!pendingIncludeGroup && !includeReplacementTimer) {
              scheduleIncludeReplacementRetry(includeGeneration, group.usePolling, err);
            }
          }
        });
      }
      return group;
    } catch (err) {
      closeIncludeGroup(group);
      throw err;
    }
  };

  function stageIncludeReplacement(generation: number) {
    if (
      stopped ||
      generation !== includeGeneration ||
      pendingIncludeGroup ||
      watcherPathsEqual(desiredIncludePaths, activeIncludeGroup.paths)
    ) {
      return;
    }
    if (desiredIncludePaths.length === 0) {
      pendingIncludeGroup = emptyIncludeGroup();
      activateIncludeGroup(pendingIncludeGroup);
      return;
    }
    try {
      pendingIncludeGroup = createIncludeGroup([...desiredIncludePaths], generation);
    } catch (err) {
      scheduleIncludeReplacementRetry(
        generation,
        resolveChokidarUsePolling(includeDegradedToPolling),
        err,
      );
    }
  }

  const replaceWatchedPaths = (includeFilePaths: readonly string[]) => {
    const nextPaths = normalizeIncludeWatcherPaths(opts.watchPath, includeFilePaths);
    if (watcherPathsEqual(nextPaths, desiredIncludePaths)) {
      return;
    }
    includeGeneration += 1;
    desiredIncludePaths = nextPaths;
    includeReplacementRetries = 0;
    if (includeReplacementTimer) {
      clearTimeout(includeReplacementTimer);
      includeReplacementTimer = null;
    }
    const stagedGroup = pendingIncludeGroup;
    pendingIncludeGroup = null;
    closeIncludeGroup(stagedGroup);
    if (watcherPathsEqual(nextPaths, activeIncludeGroup.paths)) {
      includeHotReloadDisabled = false;
      return;
    }
    stageIncludeReplacement(includeGeneration);
  };

  const createWatcher = () => {
    if (stopped) {
      return;
    }
    const next = createWatcherInstance(
      opts.watchPath,
      resolveChokidarUsePolling(degradedToPolling),
    );
    watcher = next;
    watcherUsesPolling = Boolean(next.options.usePolling);
    rootHotReloadDisabled = false;
    const scheduleIfActive = (changedPath: string) => {
      if (next === watcher) {
        scheduleFromWatcher(changedPath);
      }
    };
    next.on("add", scheduleIfActive);
    next.on("change", scheduleIfActive);
    next.on("unlink", scheduleIfActive);
    next.on("error", (err) => handleWatcherError(next, err));
  };

  const handleWatcherError = (source: ConfigWatcher, err: unknown) => {
    // Ignore stale errors from a watcher we already replaced or stopped.
    if (stopped || source !== watcher) {
      return;
    }
    const failedWatcherUsedPolling = watcherUsesPolling;
    watcher = null;
    watcherUsesPolling = false;
    closeWatcher(source);
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
      rootHotReloadDisabled = true;
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
  if (initialIncludePaths.length > 0) {
    try {
      activeIncludeGroup = createIncludeGroup(initialIncludePaths, includeGeneration);
    } catch (err) {
      activeIncludeGroup = emptyIncludeGroup();
      scheduleIncludeReplacementRetry(
        includeGeneration,
        resolveChokidarUsePolling(includeDegradedToPolling),
        err,
      );
    }
  }

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
      if (includeReplacementTimer) {
        clearTimeout(includeReplacementTimer);
        includeReplacementTimer = null;
      }
      unsubscribeFromWrites();
      const rootWatcher = watcher;
      const activeIncludes = activeIncludeGroup;
      const stagedIncludes = pendingIncludeGroup;
      watcher = null;
      activeIncludeGroup = emptyIncludeGroup();
      pendingIncludeGroup = null;
      await Promise.all(
        [
          ...(rootWatcher ? [rootWatcher] : []),
          ...activeIncludes.watchers,
          ...(stagedIncludes?.watchers ?? []),
        ].map(async (target) => await target.close().catch(() => {})),
      );
    },
    hotReloadStatus: () =>
      rootHotReloadDisabled || includeHotReloadDisabled ? "disabled" : "active",
  };
}
