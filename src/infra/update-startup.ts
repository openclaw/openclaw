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
import type { RemoteCatalogPublicationResult } from "../model-catalog/remote-overlay.js";
import {
  refreshRemoteModelCatalog,
  REMOTE_MODEL_CATALOG_TTL_MS,
} from "../model-catalog/remote-refresh.js";
import { readConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-write-async.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import type { GatewayScheduler } from "./gateway-scheduler.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";
import { checkTelemetryUpdate } from "./telemetry.js";
import { UpdateCampaignController } from "./update-campaign.js";
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
import {
  compareSemverStrings,
  resolveNpmChannelTag,
  type UpdateCheckResult,
} from "./update-check.js";
import { devUpdateTargetFromGitTarget } from "./update-dev-target.js";
import { resolveDevGitCommits } from "./update-git-metadata.js";
import {
  prepareStartupUpdateInstall,
  resolveStartupInstallStatus,
  withUpdateInstallStatus,
} from "./update-install-status.js";
import { runCampaignUpdate, type AutoUpdateRunner } from "./update-startup-auto-run.js";
import {
  getUpdateSchedule,
  resetUpdateStatusState,
  setUpdateAvailableCache,
  setUpdateScheduleCache,
  withoutUpdateCampaign,
  withoutUpdateTarget,
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

export function resetUpdateAvailableStateForTest(scheduler: GatewayScheduler): void {
  resetUpdateStatusState();
  createGatewayUpdateLifecycle(scheduler);
}

const UPDATE_CHECK_STATE_KEY = "update.checkState";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const AUTO_STABLE_DELAY_HOURS = 6;
const AUTO_STABLE_JITTER_HOURS = 12;

function resolveCheckIntervalMs(
  cfg: OpenClawConfig,
  installKind?: UpdateCheckResult["installKind"],
): number {
  const channel = normalizeUpdateChannel(cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  return cfg.update?.auto?.enabled &&
    (channel === "stable" || channel === "beta" || (channel === "dev" && installKind === "git"))
    ? ONE_HOUR_MS
    : UPDATE_CHECK_INTERVAL_MS;
}

async function readState(): Promise<UpdateCheckState> {
  return (await readConfigMachineStateAsync<UpdateCheckState>(UPDATE_CHECK_STATE_KEY)) ?? {};
}

async function writeState(state: UpdateCheckState): Promise<void> {
  await writeConfigMachineStateAsync(UPDATE_CHECK_STATE_KEY, state);
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
  return {
    currentVersion: VERSION,
    latestVersion,
    channel: state.lastAvailableTag?.trim() || channelToNpmTag(channel),
  };
}

function clearAvailabilityState(nextState: UpdateCheckState): void {
  delete nextState.lastAvailableVersion;
  delete nextState.lastAvailableTag;
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
  nextState: UpdateCheckState;
  nowMs: number;
  version: string;
  tag: string;
}): number {
  if (!params.nextState.autoInstallId) {
    params.nextState.autoInstallId = params.nextState.autoInstallId?.trim() || randomUUID();
  }
  const matchesExisting =
    params.nextState.autoFirstSeenVersion === params.version &&
    params.nextState.autoFirstSeenTag === params.tag;

  if (!matchesExisting) {
    params.nextState.autoFirstSeenVersion = params.version;
    params.nextState.autoFirstSeenTag = params.tag;
    params.nextState.autoFirstSeenAt = resolveUpdateCheckTimestamp(params.nowMs);
  }

  const parsedFirstSeenMs = params.nextState.autoFirstSeenAt
    ? Date.parse(params.nextState.autoFirstSeenAt)
    : params.nowMs;
  const firstSeenMs = Number.isFinite(parsedFirstSeenMs) ? parsedFirstSeenMs : params.nowMs;
  const baseDelayMs = AUTO_STABLE_DELAY_HOURS * ONE_HOUR_MS;
  const bucket = createHash("sha256")
    .update(`${params.nextState.autoInstallId}:${params.version}:${params.tag}`)
    .digest()
    .readUInt32BE(0);
  const jitterMs = bucket % (AUTO_STABLE_JITTER_HOURS * ONE_HOUR_MS + 1);

  return firstSeenMs + baseDelayMs + jitterMs;
}

function clearAutoState(nextState: UpdateCheckState): void {
  delete nextState.autoFirstSeenVersion;
  delete nextState.autoFirstSeenTag;
  delete nextState.autoFirstSeenAt;
}

/** Shares local install discovery within the Gateway lifecycle. */
export function initializeGatewayUpdateStatus(): ReturnType<typeof resolveStartupInstallStatus> {
  return currentUpdateCheckLifecycle().initialize();
}

async function recordAutoUpdateAttempt(version: string): Promise<void> {
  const attemptAt = resolveUpdateCheckNowMs(Date.now());
  const attemptState = await readState();
  attemptState.autoLastAttemptVersion = version;
  attemptState.autoLastAttemptAt = resolveUpdateCheckTimestamp(attemptAt);
  await writeState(attemptState);
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
  const setAvailable = (next: UpdateAvailable | null) =>
    setUpdateAvailableCache({ next, onUpdateAvailableChange: params.onUpdateAvailableChange });
  const setSchedule = (next: UpdateScheduleState) =>
    setUpdateScheduleCache({ next, onUpdateScheduleChange: params.onUpdateScheduleChange });
  params.signal?.throwIfAborted();
  if (!params.allowInTests && (process.env.VITEST || process.env.NODE_ENV === "test")) {
    return;
  }
  if (params.isNixMode) {
    return;
  }
  const updateCampaign = (lifecycle.campaign ??= new UpdateCampaignController(lifecycle.scheduler));
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
    setAvailable(null);
    const schedule = getUpdateSchedule();
    const channel = configChannel ?? schedule?.channel ?? DEFAULT_PACKAGE_CHANNEL;
    const currentSchedule =
      schedule?.channel === channel ? schedule : { channel, autoEnabled: false };
    setSchedule(withoutUpdateTarget({ ...currentSchedule, autoEnabled: false }));
    return;
  }
  const autoDisabledByExternalSupervisor = isGatewayExternallySupervised();
  const {
    installStatus,
    channel: configuredChannel,
    readOnlySchedule,
  } = await prepareStartupUpdateInstall(lifecycle.initialize, configChannel, params.signal);
  if (readOnlySchedule) {
    updateCampaign.clear();
    setAvailable(null);
    setSchedule(readOnlySchedule);
    return;
  }
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
  setSchedule(autoDesired ? initialSchedule : withoutUpdateCampaign(initialSchedule));
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
    setSchedule(campaign ? { ...current, campaign } : withoutUpdateCampaign(current));
  };

  if (configuredChannel === "extended-stable" || configuredChannel === "dev") {
    setSchedule(
      withUpdateInstallStatus(
        getUpdateSchedule() ?? initialSchedule,
        installStatus.status,
        configuredChannel === "dev",
        installStatus.installReceipt,
        installStatus.root,
      ),
    );
  }
  if (configuredChannel === "extended-stable") {
    if (installStatus.status.installKind !== "package") {
      updateCampaign.clear();
      setAvailable(null);
      setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
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
  const state = await readState();
  const rawNow = Date.now();
  const now = resolveUpdateCheckNowMs(rawNow);
  const rawNowIsValid = asDateTimestampMs(rawNow) !== undefined;
  const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
  const recentAttempt =
    lastAttemptAt != null && Number.isFinite(lastAttemptAt) && now - lastAttemptAt < ONE_HOUR_MS;
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  const persistedAvailable = isDevGit
    ? null
    : resolvePersistedUpdateAvailable(state, configuredChannel);
  const cacheMatchesChannel = state.lastCheckedChannel === configuredChannel;
  const shouldBypassSharedThrottle = isDevGit || !cacheMatchesChannel;
  setAvailable(persistedAvailable);
  if (persistedAvailable) {
    setSchedule({
      ...(getUpdateSchedule() ?? initialSchedule),
      target: { kind: "package", version: persistedAvailable.latestVersion },
    });
  }
  const checkIntervalMs = shouldRunAutoUpdate
    ? resolveCheckIntervalMs(cfg, installStatus?.status.installKind)
    : UPDATE_CHECK_INTERVAL_MS;
  if (
    !shouldBypassSharedThrottle &&
    rawNowIsValid &&
    lastCheckedAt &&
    Number.isFinite(lastCheckedAt) &&
    now - lastCheckedAt < checkIntervalMs
  ) {
    return;
  }

  const { root, status, installReceipt } = installStatus;
  const announceUpdate = (
    target: NonNullable<UpdateScheduleState["target"]>,
    channel: "stable" | "beta" | "dev",
    tag: string,
  ) =>
    updateCampaign.announce({
      target,
      inspect: params.activeWorkInspectors,
      onChange: onCampaignChange,
      apply: ({ forced }) =>
        lifecycle.run(() =>
          runCampaignUpdate({
            channel,
            mode: target.kind === "git" ? "git" : status.packageManager,
            version: target.kind === "git" ? target.upstreamSha : target.version,
            tag,
            forced,
            root: root ?? status.root ?? undefined,
            ...(target.kind === "git" ? { devTarget: devUpdateTargetFromGitTarget(target) } : {}),
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
  setSchedule(
    withUpdateInstallStatus(
      getUpdateSchedule() ?? initialSchedule,
      status,
      isDevGit,
      installReceipt,
      root,
    ),
  );

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
      setAvailable(null);
      setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
      await writeState(nextState);
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
    setAvailable(nextAvailable);
    setSchedule({ ...(getUpdateSchedule() ?? initialSchedule), target });

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
      if (!recentAttempt) {
        announceUpdate(target, "dev", "dev");
      }
    } else {
      updateCampaign.clear();
    }
    await writeState(nextState);
    return;
  }

  if (status.installKind !== "package") {
    clearAvailabilityState(nextState);
    clearAutoState(nextState);
    setAvailable(null);
    updateCampaign.clear();
    setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
    await writeState(nextState);
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
      setAvailable(null);
      updateCampaign.clear();
      setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
    }
    await writeState(nextState);
    return;
  }
  const cmp = compareSemverStrings(VERSION, resolved.version);
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
    setSchedule({ ...(getUpdateSchedule() ?? initialSchedule), target });
    setAvailable(nextAvailable);
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
      const applyAfterMs =
        channel === "stable"
          ? resolveStableAutoApplyAtMs({ nextState, nowMs: now, version: resolved.version, tag })
          : null;
      if (applyAfterMs !== null && now < applyAfterMs) {
        params.log.info("auto-update deferred (stable rollout window active)", {
          version: resolved.version,
          tag,
          applyAfter: applyAfterMs ? resolveUpdateCheckTimestamp(applyAfterMs) : undefined,
        });
      } else if (recentAttempt && state.autoLastAttemptVersion === resolved.version) {
        params.log.info("auto-update deferred (recent attempt exists)", {
          version: resolved.version,
          tag,
        });
      } else {
        announceUpdate(target, channel, tag);
      }
    }
  } else {
    clearAvailabilityState(nextState);
    if (channel !== "extended-stable") {
      clearAutoState(nextState);
    }
    setAvailable(null);
    updateCampaign.clear();
    setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
  }

  await writeState(nextState);
}

export function createGatewayUpdateCheck(params: {
  lifecycle: UpdateCheckLifecycle;
  getConfig: () => OpenClawConfig;
  applyRemoteCatalogUpdate: (signal: AbortSignal) => Promise<RemoteCatalogPublicationResult>;
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
  const { lifecycle } = params;
  let started = false;
  return {
    initialize: lifecycle.initialize,
    stop: lifecycle.stop,
    start: () => {
      if (started || lifecycle.signal.aborted) {
        return;
      }
      started = true;
      lifecycle.schedule("update.check", async () => {
        try {
          await runGatewayUpdateCheck(params, lifecycle);
        } catch {
          // Discovery failures must not crash or retire the Gateway update loop.
        }
        return resolveCheckIntervalMs(params.getConfig(), getUpdateSchedule()?.install?.kind);
      });
      lifecycle.schedule("update.remote-model-catalog", async () => {
        let nextCheckInMs = REMOTE_MODEL_CATALOG_TTL_MS;
        try {
          const result = await refreshRemoteModelCatalog({
            config: params.getConfig(),
            signal: lifecycle.signal,
          });
          if (lifecycle.signal.aborted) {
            return REMOTE_MODEL_CATALOG_TTL_MS;
          }
          nextCheckInMs =
            result.status === "fresh" ? result.nextCheckInMs : REMOTE_MODEL_CATALOG_TTL_MS;
          if (result.status === "error") {
            params.log.info(
              "remote model catalog refresh failed; next check in 6 hours, or run openclaw models refresh",
              { error: result.error },
            );
          } else if (result.status !== "disabled") {
            const state = await params.applyRemoteCatalogUpdate(lifecycle.signal);
            if (state === "published") {
              params.log.info("remote model catalog applied");
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
      });
    },
  };
}
