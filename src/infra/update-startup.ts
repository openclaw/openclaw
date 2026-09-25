// Runs startup update checks and optional auto-update handoff.
import { createHash, randomUUID } from "node:crypto";
import {
  asDateTimestampMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRemoteCatalogUrl } from "../model-catalog/remote-config.js";
import { checkRemoteModelCatalogUpdate } from "../model-catalog/remote-overlay.js";
import {
  refreshRemoteModelCatalog,
  REMOTE_MODEL_CATALOG_TTL_MS,
} from "../model-catalog/remote-refresh.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";
import { checkTelemetryUpdate } from "./telemetry.js";
import { gatewayUpdateCampaign, type UpdateCampaignController } from "./update-campaign.js";
import {
  channelToNpmTag,
  DEV_BRANCH,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  DEFAULT_PACKAGE_CHANNEL,
  type UpdateChannel,
} from "./update-channels.js";
import {
  createGatewayUpdateLifecycle,
  currentUpdateCheckLifecycle,
  type UpdateCheckLifecycle,
} from "./update-check-lifecycle.js";
import { compareSemverStrings, resolveNpmChannelTag } from "./update-check.js";
import { devUpdateTargetFromGitTarget } from "./update-dev-target.js";
import { resolveDevGitCommits } from "./update-git-metadata.js";
import { resolveStartupInstallStatus, withUpdateInstallStatus } from "./update-install-status.js";
import { runCampaignUpdate, type AutoUpdateRunner } from "./update-startup-auto-run.js";
import {
  getUpdateSchedule,
  resetUpdateStatusState,
  setUpdateAvailableCache,
  setUpdateScheduleCache,
} from "./update-status-state.js";

type UpdateCheckState = {
  lastCheckedAt?: string;
  lastCheckedChannel?: UpdateChannel;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
};

export async function getUpdateEffectiveChannel(): Promise<UpdateChannel> {
  const { status } = await initializeGatewayUpdateStatus();
  return resolveEffectiveUpdateChannel({
    currentVersion: VERSION,
    installKind: status.installKind,
    git: status.git,
  }).channel;
}

export function resetUpdateAvailableStateForTest(): void {
  resetUpdateStatusState();
  createGatewayUpdateLifecycle();
}

const UPDATE_CHECK_STATE_KEY = "update.checkState";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const AUTO_STABLE_DELAY_HOURS = 6;
const AUTO_STABLE_JITTER_HOURS = 12;

function shouldSkipCheck(allowInTests: boolean): boolean {
  return !allowInTests && Boolean(process.env.VITEST || process.env.NODE_ENV === "test");
}

function resolveCheckIntervalMs(
  cfg: OpenClawConfig,
  installKind?: "package" | "git" | "unknown",
): number {
  const channel = normalizeUpdateChannel(cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  return cfg.update?.auto?.enabled &&
    (channel === "stable" || channel === "beta" || (channel === "dev" && installKind === "git"))
    ? ONE_HOUR_MS
    : UPDATE_CHECK_INTERVAL_MS;
}

function readState(): UpdateCheckState {
  return readConfigMachineState<UpdateCheckState>(UPDATE_CHECK_STATE_KEY) ?? {};
}

function writeState(state: UpdateCheckState): void {
  writeConfigMachineState(UPDATE_CHECK_STATE_KEY, state);
}

function withoutCampaign(schedule: UpdateScheduleState): UpdateScheduleState {
  const { campaign: _campaign, ...rest } = schedule;
  return rest;
}

function withoutTarget(schedule: UpdateScheduleState): UpdateScheduleState {
  const { target: _target, campaign: _campaign, ...rest } = schedule;
  return rest;
}

function isPersistedAvailabilityForChannel(params: {
  state: UpdateCheckState;
  channel: UpdateChannel;
}): boolean {
  if (params.state.lastCheckedChannel !== params.channel) {
    return false;
  }
  const tag = params.state.lastAvailableTag?.trim();
  if (params.channel === "stable") {
    return !tag || tag === "latest";
  }
  if (params.channel === "beta") {
    return tag === "beta" || tag === "latest";
  }
  return tag === params.channel;
}

function resolvePersistedUpdateAvailable(
  state: UpdateCheckState,
  channel: UpdateChannel,
): UpdateAvailable | null {
  const latestVersion = state.lastAvailableVersion?.trim();
  if (!latestVersion || !isPersistedAvailabilityForChannel({ state, channel })) {
    return null;
  }
  const cmp = compareSemverStrings(VERSION, latestVersion);
  if (cmp == null || cmp >= 0) {
    return null;
  }
  const persistedTag = state.lastAvailableTag?.trim() || channelToNpmTag(channel);
  return {
    currentVersion: VERSION,
    latestVersion,
    channel: persistedTag,
  };
}

function clearAvailabilityState(nextState: UpdateCheckState): void {
  delete nextState.lastAvailableVersion;
  delete nextState.lastAvailableTag;
}

function resolveStableJitterMs(params: {
  installId: string;
  version: string;
  tag: string;
  jitterWindowMs: number;
}): number {
  if (params.jitterWindowMs <= 0) {
    return 0;
  }
  const hash = createHash("sha256")
    .update(`${params.installId}:${params.version}:${params.tag}`)
    .digest();
  const bucket = hash.readUInt32BE(0);
  return bucket % (Math.floor(params.jitterWindowMs) + 1);
}

function resolveUpdateCheckNowMs(valueMs: unknown): number {
  return asDateTimestampMs(valueMs) ?? asDateTimestampMs(Date.now()) ?? 0;
}

function resolveUpdateCheckTimestamp(valueMs: unknown): string {
  return (
    timestampMsToIsoString(valueMs) ??
    timestampMsToIsoString(resolveUpdateCheckNowMs(Date.now())) ??
    new Date().toISOString()
  );
}

function resolveStableAutoApplyAtMs(params: {
  state: UpdateCheckState;
  nextState: UpdateCheckState;
  nowMs: number;
  version: string;
  tag: string;
}): number {
  if (!params.nextState.autoInstallId) {
    params.nextState.autoInstallId = params.state.autoInstallId?.trim() || randomUUID();
  }
  const installId = params.nextState.autoInstallId;
  const matchesExisting =
    params.state.autoFirstSeenVersion === params.version &&
    params.state.autoFirstSeenTag === params.tag;

  if (!matchesExisting) {
    params.nextState.autoFirstSeenVersion = params.version;
    params.nextState.autoFirstSeenTag = params.tag;
    params.nextState.autoFirstSeenAt = resolveUpdateCheckTimestamp(params.nowMs);
  } else {
    params.nextState.autoFirstSeenVersion = params.state.autoFirstSeenVersion;
    params.nextState.autoFirstSeenTag = params.state.autoFirstSeenTag;
    params.nextState.autoFirstSeenAt = params.state.autoFirstSeenAt;
  }

  const parsedFirstSeenMs = params.nextState.autoFirstSeenAt
    ? Date.parse(params.nextState.autoFirstSeenAt)
    : params.nowMs;
  const firstSeenMs = Number.isFinite(parsedFirstSeenMs) ? parsedFirstSeenMs : params.nowMs;
  const baseDelayMs = AUTO_STABLE_DELAY_HOURS * ONE_HOUR_MS;
  const jitterWindowMs = AUTO_STABLE_JITTER_HOURS * ONE_HOUR_MS;
  const jitterMs = resolveStableJitterMs({
    installId,
    version: params.version,
    tag: params.tag,
    jitterWindowMs,
  });

  return firstSeenMs + baseDelayMs + jitterMs;
}

function clearAutoState(nextState: UpdateCheckState): void {
  delete nextState.autoFirstSeenVersion;
  delete nextState.autoFirstSeenTag;
  delete nextState.autoFirstSeenAt;
}

/** Caches only the fast local install probe; remote Git refresh remains post-ready. */
export function initializeGatewayUpdateStatus(): ReturnType<typeof resolveStartupInstallStatus> {
  return currentUpdateCheckLifecycle().initialize();
}

/** Refreshes the read-only Dev checkout comparison used by update.status. */
export function refreshGatewayUpdateStatus(cfg: OpenClawConfig): Promise<void> {
  const lifecycle = currentUpdateCheckLifecycle();
  const pending = lifecycle.refreshes.get(cfg);
  if (pending) {
    return pending;
  }
  const refresh = lifecycle
    .run(async (signal) => {
      const scheduleAtStart = getUpdateSchedule();
      const configured = normalizeUpdateChannel(cfg.update?.channel);
      const channel =
        configured ??
        resolveEffectiveUpdateChannel({
          currentVersion: VERSION,
          ...(await lifecycle.initialize()).status,
        }).channel;
      const isCurrent = () =>
        lifecycle.isCurrent() &&
        !signal.aborted &&
        (getUpdateSchedule() === scheduleAtStart || getUpdateSchedule()?.channel === channel);
      if (channel !== "dev" || !isCurrent()) {
        return;
      }
      const { root, status, installReceipt } = await resolveStartupInstallStatus(true, signal);
      if (!isCurrent()) {
        return;
      }
      const schedule = getUpdateSchedule();
      const current =
        schedule?.channel === channel
          ? schedule
          : { channel, autoEnabled: Boolean(cfg.update?.auto?.enabled) };
      setUpdateScheduleCache({
        next: withUpdateInstallStatus(current, status, true, installReceipt, root),
      });
    })
    .finally(() => {
      if (lifecycle.refreshes.get(cfg) === refresh) {
        lifecycle.refreshes.delete(cfg);
      }
    });
  lifecycle.refreshes.set(cfg, refresh);
  return refresh;
}

function recordAutoUpdateAttempt(version: string): void {
  const attemptAt = resolveUpdateCheckNowMs(Date.now());
  const attemptState = readState();
  attemptState.autoLastAttemptVersion = version;
  attemptState.autoLastAttemptAt = resolveUpdateCheckTimestamp(attemptAt);
  writeState(attemptState);
}

export async function runGatewayUpdateCheck(
  params: {
    getConfig: () => OpenClawConfig;
    log: { info: (msg: string, meta?: Record<string, unknown>) => void };
    isNixMode: boolean;
    allowInTests?: boolean;
    onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
    onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
    onUpdateRunCreated?: () => void;
    activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
    updateCampaign?: UpdateCampaignController;
    runAutoUpdate?: AutoUpdateRunner;
    signal?: AbortSignal;
  },
  lifecycle = currentUpdateCheckLifecycle(),
): Promise<void> {
  return lifecycle.run((signal) =>
    runGatewayUpdateCheckOwned(
      { ...params, signal: params.signal ? AbortSignal.any([signal, params.signal]) : signal },
      lifecycle,
    ),
  );
}

async function runGatewayUpdateCheckOwned(
  params: Parameters<typeof runGatewayUpdateCheck>[0] & { signal: AbortSignal },
  lifecycle: UpdateCheckLifecycle,
): Promise<void> {
  params.signal?.throwIfAborted();
  if (shouldSkipCheck(Boolean(params.allowInTests))) {
    return;
  }
  if (params.isNixMode) {
    return;
  }
  const updateCampaign = params.updateCampaign ?? gatewayUpdateCampaign;
  lifecycle.campaign = gatewayUpdateCampaign;
  // The admitted target belongs to the applying owner until it settles.
  if (updateCampaign.getState()?.state === "applying") {
    return;
  }
  const cfg = params.getConfig();
  const configChannel = normalizeUpdateChannel(cfg.update?.channel);
  const runAuto: AutoUpdateRunner =
    params.runAutoUpdate ??
    (async (runParams) => {
      const { runAutoUpdateCommand } = await import("./update-startup-auto-run.js");
      return runAutoUpdateCommand(runParams, params.log);
    });
  const autoEnabled = Boolean(cfg.update?.auto?.enabled);
  const autoDisabledByEnv = isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE);
  if (cfg.update?.checkOnStart === false || autoDisabledByEnv) {
    updateCampaign.clear();
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    const schedule = getUpdateSchedule();
    const channel = configChannel ?? schedule?.channel ?? DEFAULT_PACKAGE_CHANNEL;
    const currentSchedule =
      schedule?.channel === channel ? schedule : { channel, autoEnabled: false };
    setUpdateScheduleCache({
      next: withoutTarget({ ...currentSchedule, autoEnabled: false }),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
    return;
  }
  const autoDisabledByExternalSupervisor = isGatewayExternallySupervised();
  const initializedInstallStatus = await lifecycle.initialize();
  params.signal?.throwIfAborted();
  const potentialChannel = resolveEffectiveUpdateChannel({
    configChannel,
    currentVersion: VERSION,
    installKind: initializedInstallStatus.status.installKind,
    git: initializedInstallStatus.status.git,
  }).channel;
  let installStatus = initializedInstallStatus;
  if (potentialChannel === "dev" && installStatus.status.installKind === "git") {
    installStatus = await resolveStartupInstallStatus(true, params.signal);
    params.signal?.throwIfAborted();
  }
  const configuredChannel = resolveEffectiveUpdateChannel({
    configChannel,
    currentVersion: VERSION,
    installKind: installStatus.status.installKind,
    git: installStatus.status.git,
  }).channel;
  const autoDesired =
    (configuredChannel === "stable" ||
      configuredChannel === "beta" ||
      configuredChannel === "dev") &&
    autoEnabled &&
    !autoDisabledByExternalSupervisor;

  if (updateCampaign.getState()?.state === "applying") {
    return;
  }
  const canApply = () => {
    const current = params.getConfig();
    return (
      current.update?.auto?.enabled === true &&
      current.update?.checkOnStart !== false &&
      !isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE) &&
      !isGatewayExternallySupervised() &&
      resolveEffectiveUpdateChannel({
        configChannel: normalizeUpdateChannel(current.update?.channel),
        currentVersion: VERSION,
        ...installStatus.status,
      }).channel === configuredChannel
    );
  };
  const schedule = getUpdateSchedule();
  const channelChanged = schedule !== null && schedule.channel !== configuredChannel;
  if (channelChanged) {
    updateCampaign.clear();
  }
  const priorSchedule = schedule?.channel === configuredChannel ? schedule : null;
  const initialSchedule: UpdateScheduleState = priorSchedule
    ? { ...priorSchedule, autoEnabled }
    : { channel: configuredChannel, autoEnabled };
  setUpdateScheduleCache({
    next: autoDesired ? initialSchedule : withoutCampaign(initialSchedule),
    onUpdateScheduleChange: params.onUpdateScheduleChange,
  });
  if (!autoDesired) {
    updateCampaign.clear();
  }
  const onCampaignChange = (campaign: UpdateScheduleState["campaign"] | undefined) => {
    const current = getUpdateSchedule();
    if (!current || current.channel !== configuredChannel) {
      return;
    }
    const target =
      current.target?.kind === "package"
        ? current.target.version
        : current.target?.kind === "git"
          ? {
              upstreamSha: current.target.upstreamSha,
              commitsBehind: current.target.commitsBehind,
            }
          : undefined;
    if (campaign) {
      params.log.info(`update campaign ${campaign.state}`, {
        campaignId: campaign.id,
        state: campaign.state,
        channel: configuredChannel,
        ...(target === undefined ? {} : { target }),
        ...(campaign.applyAtMs === undefined ? {} : { applyAtMs: campaign.applyAtMs }),
        ...(campaign.holdUntilMs === undefined ? {} : { holdUntilMs: campaign.holdUntilMs }),
        forceAtMs: campaign.forceAtMs,
      });
    } else {
      params.log.info("update campaign ended", {
        ...(current.campaign?.id ? { campaignId: current.campaign.id } : {}),
        channel: configuredChannel,
        ...(target === undefined ? {} : { target }),
      });
    }
    setUpdateScheduleCache({
      next: campaign ? { ...current, campaign } : withoutCampaign(current),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
  };

  if (configuredChannel === "extended-stable" || configuredChannel === "dev") {
    setUpdateScheduleCache({
      next: withUpdateInstallStatus(
        getUpdateSchedule() ?? initialSchedule,
        installStatus.status,
        configuredChannel === "dev",
        installStatus.installReceipt,
        installStatus.root,
      ),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
  }
  if (configuredChannel === "extended-stable") {
    if (installStatus.status.installKind !== "package") {
      updateCampaign.clear();
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
      setUpdateScheduleCache({
        next: withoutTarget(getUpdateSchedule() ?? initialSchedule),
        onUpdateScheduleChange: params.onUpdateScheduleChange,
      });
      return;
    }
  }

  const isDevGit = configuredChannel === "dev" && installStatus?.status.installKind === "git";
  const shouldRunAutoUpdate =
    autoDesired && (configuredChannel === "stable" || configuredChannel === "beta" || isDevGit);
  if (!shouldRunAutoUpdate) {
    updateCampaign.clear();
  }
  const telemetryUpdate = await checkTelemetryUpdate(params.getConfig, { surface: "gateway" });
  params.signal?.throwIfAborted();
  const state = readState();
  const rawNow = Date.now();
  const now = resolveUpdateCheckNowMs(rawNow);
  const rawNowIsValid = asDateTimestampMs(rawNow) !== undefined;
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  const persistedAvailable = isDevGit
    ? null
    : resolvePersistedUpdateAvailable(state, configuredChannel);
  const cacheMatchesChannel = state.lastCheckedChannel === configuredChannel;
  const shouldBypassSharedThrottle = isDevGit || !cacheMatchesChannel;
  setUpdateAvailableCache({
    next: persistedAvailable,
    onUpdateAvailableChange: params.onUpdateAvailableChange,
  });
  if (persistedAvailable) {
    setUpdateScheduleCache({
      next: {
        ...(getUpdateSchedule() ?? initialSchedule),
        target: { kind: "package", version: persistedAvailable.latestVersion },
      },
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
  }
  const checkIntervalMs = shouldRunAutoUpdate
    ? resolveCheckIntervalMs(cfg, installStatus?.status.installKind)
    : UPDATE_CHECK_INTERVAL_MS;
  if (
    !shouldBypassSharedThrottle &&
    rawNowIsValid &&
    lastCheckedAt &&
    Number.isFinite(lastCheckedAt)
  ) {
    if (now - lastCheckedAt < checkIntervalMs) {
      return;
    }
  }

  const { root, status, installReceipt } = installStatus;
  setUpdateScheduleCache({
    next: withUpdateInstallStatus(
      getUpdateSchedule() ?? initialSchedule,
      status,
      isDevGit,
      installReceipt,
      root,
    ),
    onUpdateScheduleChange: params.onUpdateScheduleChange,
  });

  const nextState: UpdateCheckState = {
    ...state,
    lastCheckedAt: resolveUpdateCheckTimestamp(now),
    lastCheckedChannel: configuredChannel,
  };
  if (!cacheMatchesChannel) {
    clearAvailabilityState(nextState);
  }

  if (isDevGit) {
    clearAvailabilityState(nextState);
    clearAutoState(nextState);
    const git = status.git;
    if (
      typeof git?.behind !== "number" ||
      git.behind <= 0 ||
      !git.sha ||
      !git.upstream ||
      !git.upstreamSha
    ) {
      updateCampaign.clear();
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
      setUpdateScheduleCache({
        next: withoutTarget(getUpdateSchedule() ?? initialSchedule),
        onUpdateScheduleChange: params.onUpdateScheduleChange,
      });
      writeState(nextState);
      return;
    }
    const currentSha = git.sha;
    const upstreamRef = git.upstream;
    const upstreamSha = git.upstreamSha;
    const commitsBehind = git.behind;
    const commits = await resolveDevGitCommits({
      root: git.root,
      currentSha,
      upstreamSha,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();

    const target: NonNullable<UpdateScheduleState["target"]> = {
      kind: "git",
      upstreamRef,
      upstreamSha,
      commitsBehind,
    };
    if (!updateCampaign.reconcileTarget(target)) {
      return;
    }
    const nextAvailable: UpdateAvailable = {
      currentVersion: VERSION,
      latestVersion: VERSION,
      channel: "dev",
      currentSha,
      upstreamRef,
      upstreamSha,
      ...(git.repositoryUrl ? { repositoryUrl: git.repositoryUrl } : {}),
      commitsBehind,
      commits,
    };
    setUpdateAvailableCache({
      next: nextAvailable,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    setUpdateScheduleCache({
      next: { ...(getUpdateSchedule() ?? initialSchedule), target },
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });

    if (autoEnabled && autoDisabledByExternalSupervisor) {
      params.log.info("auto-update delegated to external supervisor", {
        version: upstreamSha,
        tag: "dev",
        reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      });
    }
    const hasTrackedDevUpstream =
      (git.branch === DEV_BRANCH || git.branch === "HEAD") && git.upstreamSource === "tracking";
    const hasReceiptBackedDetachedHead = git.branch === "HEAD" && git.upstreamSource === "receipt";
    const canRunTrackedDevCampaign =
      (hasTrackedDevUpstream || hasReceiptBackedDetachedHead) && git.ahead === 0;
    if (shouldRunAutoUpdate && canRunTrackedDevCampaign) {
      const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
      const recentAttempt =
        lastAttemptAt != null &&
        Number.isFinite(lastAttemptAt) &&
        now - lastAttemptAt < ONE_HOUR_MS;
      if (!recentAttempt) {
        updateCampaign.announce({
          target,
          inspect: params.activeWorkInspectors,
          onChange: onCampaignChange,
          apply: ({ forced }) =>
            lifecycle.run(() =>
              runCampaignUpdate({
                channel: "dev",
                mode: "git",
                version: upstreamSha,
                tag: "dev",
                forced,
                root: root ?? status.root ?? undefined,
                devTarget: devUpdateTargetFromGitTarget(target),
                log: params.log,
                runAuto,
                canApply,
                onAttempt: recordAutoUpdateAttempt,
                campaign: updateCampaign,
                onUpdateRunCreated: params.onUpdateRunCreated,
                signal: params.signal,
              }),
            ),
        });
      }
    } else {
      updateCampaign.clear();
    }
    writeState(nextState);
    return;
  }

  if (status.installKind !== "package") {
    clearAvailabilityState(nextState);
    clearAutoState(nextState);
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    updateCampaign.clear();
    setUpdateScheduleCache({
      next: withoutTarget(getUpdateSchedule() ?? initialSchedule),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
    writeState(nextState);
    return;
  }

  const channel = configuredChannel;
  const resolved =
    shouldRunAutoUpdate || channel !== "stable"
      ? await resolveNpmChannelTag({ channel })
      : {
          tag: "latest",
          version: telemetryUpdate?.version ?? null,
        };
  params.signal?.throwIfAborted();
  const tag = resolved.tag;
  if (!resolved.version) {
    if (channel === "extended-stable") {
      clearAvailabilityState(nextState);
      setUpdateAvailableCache({
        next: null,
        onUpdateAvailableChange: params.onUpdateAvailableChange,
      });
      updateCampaign.clear();
      setUpdateScheduleCache({
        next: withoutTarget(getUpdateSchedule() ?? initialSchedule),
        onUpdateScheduleChange: params.onUpdateScheduleChange,
      });
    }
    writeState(nextState);
    return;
  }
  const resolvedVersion = resolved.version;

  const cmp = compareSemverStrings(VERSION, resolvedVersion);
  if (cmp != null && cmp < 0) {
    const nextAvailable: UpdateAvailable = {
      currentVersion: VERSION,
      latestVersion: resolved.version,
      channel: tag,
    };
    const target: NonNullable<UpdateScheduleState["target"]> = {
      kind: "package",
      version: resolved.version,
    };
    if (!updateCampaign.reconcileTarget(target)) {
      return;
    }
    setUpdateScheduleCache({
      next: { ...(getUpdateSchedule() ?? initialSchedule), target },
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
    setUpdateAvailableCache({
      next: nextAvailable,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    nextState.lastAvailableVersion = resolved.version;
    nextState.lastAvailableTag = tag;
    const shouldNotify =
      state.lastNotifiedVersion !== resolved.version || state.lastNotifiedTag !== tag;
    if (shouldNotify) {
      const updateNotice = `update available (${tag}): v${resolved.version} (current v${VERSION}). Run: ${formatCliCommand("openclaw update")}`;
      const note = telemetryUpdate?.note
        ? sanitizeTerminalText(telemetryUpdate.note).trim().slice(0, 500)
        : undefined;
      params.log.info(note ? `${updateNotice} Note: ${note}` : updateNotice);
      nextState.lastNotifiedVersion = resolved.version;
      nextState.lastNotifiedTag = tag;
    }

    if (channel !== "extended-stable" && autoEnabled && autoDisabledByExternalSupervisor) {
      params.log.info("auto-update delegated to external supervisor", {
        version: resolved.version,
        tag,
        reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      });
    }

    if (shouldRunAutoUpdate && (channel === "stable" || channel === "beta")) {
      const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
      const recentAttemptForSameVersion =
        state.autoLastAttemptVersion === resolved.version &&
        lastAttemptAt != null &&
        Number.isFinite(lastAttemptAt) &&
        now - lastAttemptAt < ONE_HOUR_MS;

      let dueNow = channel === "beta";
      let applyAfterMs: number | null = null;
      if (channel === "stable") {
        applyAfterMs = resolveStableAutoApplyAtMs({
          state,
          nextState,
          nowMs: now,
          version: resolved.version,
          tag,
        });
        dueNow = now >= applyAfterMs;
      }

      if (!dueNow) {
        params.log.info("auto-update deferred (stable rollout window active)", {
          version: resolved.version,
          tag,
          applyAfter: applyAfterMs ? resolveUpdateCheckTimestamp(applyAfterMs) : undefined,
        });
      } else if (recentAttemptForSameVersion) {
        params.log.info("auto-update deferred (recent attempt exists)", {
          version: resolved.version,
          tag,
        });
      } else {
        updateCampaign.announce({
          target,
          inspect: params.activeWorkInspectors,
          onChange: onCampaignChange,
          apply: ({ forced }) =>
            lifecycle.run(() =>
              runCampaignUpdate({
                channel,
                mode: status.packageManager,
                version: resolvedVersion,
                tag,
                forced,
                root: root ?? status.root ?? undefined,
                log: params.log,
                runAuto,
                canApply,
                onAttempt: recordAutoUpdateAttempt,
                campaign: updateCampaign,
                onUpdateRunCreated: params.onUpdateRunCreated,
                signal: params.signal,
              }),
            ),
        });
      }
    }
  } else {
    if (channel === "extended-stable") {
      clearAvailabilityState(nextState);
    } else {
      clearAvailabilityState(nextState);
      clearAutoState(nextState);
    }
    setUpdateAvailableCache({
      next: null,
      onUpdateAvailableChange: params.onUpdateAvailableChange,
    });
    updateCampaign.clear();
    setUpdateScheduleCache({
      next: withoutTarget(getUpdateSchedule() ?? initialSchedule),
      onUpdateScheduleChange: params.onUpdateScheduleChange,
    });
  }

  writeState(nextState);
}

export function createGatewayUpdateCheck(params: {
  lifecycle?: UpdateCheckLifecycle;
  getConfig: () => OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
  onUpdateRunCreated?: () => void;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
}): {
  initialize: () => ReturnType<typeof resolveStartupInstallStatus>;
  start: () => void;
  stop: () => Promise<void>;
} {
  const lifecycle = params.lifecycle ?? createGatewayUpdateLifecycle();
  lifecycle.campaign = gatewayUpdateCampaign;
  let started = false;
  let observedCatalog: { sourceUrl: string; generatedAt: number } | undefined;
  return {
    initialize: lifecycle.initialize,
    stop: lifecycle.stop,
    start: () => {
      if (started || lifecycle.signal.aborted) {
        return;
      }
      started = true;
      lifecycle.schedule(async () => {
        try {
          await runGatewayUpdateCheck(params, lifecycle);
        } catch {
          // Discovery failures must not crash or retire the Gateway update loop.
        }
        return resolveCheckIntervalMs(params.getConfig(), getUpdateSchedule()?.install?.kind);
      });
      lifecycle.schedule(async () => {
        let nextCheckInMs = REMOTE_MODEL_CATALOG_TTL_MS;
        try {
          const config = params.getConfig();
          const sourceUrl = resolveRemoteCatalogUrl(config);
          const result = await refreshRemoteModelCatalog({
            config,
            signal: lifecycle.signal,
          });
          if (lifecycle.signal.aborted) {
            return REMOTE_MODEL_CATALOG_TTL_MS;
          }
          nextCheckInMs =
            result.status === "fresh" ? result.nextCheckInMs : REMOTE_MODEL_CATALOG_TTL_MS;
          if (result.status === "error") {
            params.log.info("remote model catalog refresh failed", { error: result.error });
          } else if (
            result.status !== "disabled" &&
            (observedCatalog?.sourceUrl !== sourceUrl ||
              observedCatalog.generatedAt !== result.generatedAt)
          ) {
            const expected = { sourceUrl, generatedAt: result.generatedAt };
            const state = checkRemoteModelCatalogUpdate(params.getConfig(), expected);
            if (state !== "superseded") {
              observedCatalog = expected;
            }
            if (state === "restart-required") {
              params.log.info("remote model catalog downloaded; restart the Gateway to apply it", {
                providers: result.providers,
                models: result.models,
                generatedAt: result.generatedAt,
              });
            } else if (state === "superseded") {
              params.log.info("remote model catalog check superseded; deferred to the next check");
            }
          }
        } catch (error) {
          if (!lifecycle.signal.aborted) {
            params.log.info("remote model catalog check failed", { error: String(error) });
          }
        }
        return nextCheckInMs;
      }, true);
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
