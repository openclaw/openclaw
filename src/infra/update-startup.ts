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
import { computeNextRunAtMs } from "../cron/schedule.js";
import {
  readConfigMachineStateAsync,
  writeConfigMachineStateAsync,
} from "../state/config-machine-state-async.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import type { GatewayScheduler } from "./gateway-scheduler.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";
import { compareSemverStrings } from "./npm-registry-spec.js";
import { checkTelemetryUpdate } from "./telemetry.js";
import { UpdateCampaignController } from "./update-campaign.js";
import {
  channelToNpmTag,
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
import { resolveNpmChannelTag, type UpdateCheckResult } from "./update-check.js";
import { devUpdateTargetFromGitTarget } from "./update-dev-target.js";
import {
  prepareStartupUpdateInstall,
  resolveStartupInstallStatus,
  withUpdateInstallStatus,
} from "./update-install-status.js";
import type { StartupInstallStatus } from "./update-install-status.types.js";
import { runCampaignUpdate, type AutoUpdateRunner } from "./update-startup-auto-run.js";
import { canRunDevGitCampaign, resolveDevGitUpdate } from "./update-startup-refresh.js";
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

// A configured cron occurrence opens one minute for starting a campaign. Discovery
// may finish later, so admission checks the clock again; missed windows never catch up.
function autoScheduleWindow(cfg: OpenClawConfig, nowMs: number): number | undefined {
  const expr = cfg.update?.auto?.schedule;
  if (!expr) {
    return undefined;
  }
  const minute = Math.floor(nowMs / 60_000) * 60_000;
  const occurrence = computeNextRunAtMs({ kind: "cron", expr }, minute - 1);
  return occurrence !== undefined && occurrence <= nowMs && occurrence < minute + 60_000
    ? occurrence
    : undefined;
}

function hasRecentAutoAttempt(cfg: OpenClawConfig, lastAttemptAt: number | null, nowMs: number) {
  if (lastAttemptAt === null || !Number.isFinite(lastAttemptAt)) {
    return false;
  }
  if (!cfg.update?.auto?.schedule) {
    return nowMs - lastAttemptAt < ONE_HOUR_MS;
  }
  const window = autoScheduleWindow(cfg, nowMs);
  return window === undefined || lastAttemptAt >= window;
}

export function resolveCheckIntervalMs(
  cfg: OpenClawConfig,
  installKind?: UpdateCheckResult["installKind"],
): number {
  const channel = normalizeUpdateChannel(cfg.update?.channel) ?? DEFAULT_PACKAGE_CHANNEL;
  // Stable package discovery re-reads the telemetry cache that Gateway maintenance
  // refreshes on its own daily deadline, so a release does not wait a second day.
  return (channel === "stable" && installKind === "package") ||
    (cfg.update?.auto?.enabled &&
      (channel === "stable" || channel === "beta" || (channel === "dev" && installKind === "git")))
    ? ONE_HOUR_MS
    : UPDATE_CHECK_INTERVAL_MS;
}

async function readState(): Promise<UpdateCheckState> {
  return (await readConfigMachineStateAsync<UpdateCheckState>(UPDATE_CHECK_STATE_KEY)) ?? {};
}

async function writeState(state: UpdateCheckState): Promise<void> {
  await writeConfigMachineStateAsync(UPDATE_CHECK_STATE_KEY, state);
}

function resolvePersistedUpdateAvailable(
  state: UpdateCheckState,
  channel: UpdateChannel,
): UpdateAvailable | null {
  const latestVersion = state.lastAvailableVersion?.trim();
  const tag = state.lastAvailableTag?.trim();
  const tagMatches =
    channel === "stable"
      ? !tag || tag === "latest"
      : channel === "beta"
        ? tag === "beta" || tag === "latest"
        : tag === channel;
  if (!latestVersion || state.lastCheckedChannel !== channel || !tagMatches) {
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
  const configuredSchedule = cfg.update?.auto?.schedule;
  const runAuto: AutoUpdateRunner = async (runParams) => {
    const { runAutoUpdateCommand } = await import("./update-startup-auto-run.js");
    return runAutoUpdateCommand(runParams, params.log);
  };
  const announceUpdate = (
    target: NonNullable<UpdateScheduleState["target"]>,
    installStatus: StartupInstallStatus,
    channel: "stable" | "beta" | "dev",
    tag: string,
  ) => {
    const { root, status } = installStatus;
    const canApply = () => {
      const current = params.getConfig();
      return (
        current.update?.auto?.enabled === true &&
        current.update?.auto?.schedule === configuredSchedule &&
        current.update?.checkOnStart !== false &&
        !isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE) &&
        !isGatewayExternallySupervised() &&
        resolveEffectiveUpdateChannel({
          configChannel: normalizeUpdateChannel(current.update?.channel),
          currentVersion: VERSION,
          ...installStatus.status,
        }).channel === channel
      );
    };
    if (!lifecycle.isCurrent() || params.signal.aborted || !canApply()) {
      return;
    }
    updateCampaign.announce({
      target,
      canStart: () =>
        canApply() &&
        (!cfg.update?.auto?.schedule || autoScheduleWindow(cfg, Date.now()) !== undefined),
      inspect: params.activeWorkInspectors,
      onChange: (campaign) => {
        const current = getUpdateSchedule();
        if (!current || current.channel !== channel) {
          return;
        }
        const loggedTarget =
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
            channel,
            ...(loggedTarget === undefined ? {} : { target: loggedTarget }),
            ...(campaign.applyAtMs === undefined ? {} : { applyAtMs: campaign.applyAtMs }),
            ...(campaign.holdUntilMs === undefined ? {} : { holdUntilMs: campaign.holdUntilMs }),
            forceAtMs: campaign.forceAtMs,
          });
        } else {
          params.log.info("update campaign ended", {
            ...(current.campaign?.id ? { campaignId: current.campaign.id } : {}),
            channel,
            ...(loggedTarget === undefined ? {} : { target: loggedTarget }),
          });
        }
        setSchedule(campaign ? { ...current, campaign } : withoutUpdateCampaign(current));
      },
      apply: ({ forced, target: admittedTarget }) =>
        lifecycle.run(() =>
          runCampaignUpdate({
            channel,
            mode: admittedTarget.kind === "git" ? "git" : status.packageManager,
            version:
              admittedTarget.kind === "git" ? admittedTarget.upstreamSha : admittedTarget.version,
            tag,
            forced,
            root: root ?? status.root ?? undefined,
            ...(admittedTarget.kind === "git"
              ? { devTarget: devUpdateTargetFromGitTarget(admittedTarget) }
              : {}),
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
  };
  const announceDevGitUpdate: NonNullable<UpdateCheckLifecycle["announceDevGitUpdate"]> = async (
    target,
    installStatus,
  ) => {
    await lifecycle
      .run(async () => {
        const state = await readState();
        const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
        if (
          hasRecentAutoAttempt(
            params.getConfig(),
            lastAttemptAt,
            resolveUpdateCheckNowMs(Date.now()),
          )
        ) {
          return;
        }
        announceUpdate(target, installStatus, "dev", "dev");
      })
      .catch((error: unknown) => {
        if (!params.signal.aborted) {
          params.log.info("update campaign discovery failed", { error: String(error) });
        }
      });
  };
  lifecycle.announceDevGitUpdate = announceDevGitUpdate;
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
  const initialized = await lifecycle.initialize();
  params.signal.throwIfAborted();
  // Discovery publishes only for its current installation and channel policy.
  // Opt-outs replace the background owner without superseding explicit discovery.
  const isCurrent = () =>
    lifecycle.isCurrent() &&
    lifecycle.announceDevGitUpdate === announceDevGitUpdate &&
    normalizeUpdateChannel(params.getConfig().update?.channel) === configChannel &&
    lifecycle.installStatus?.status.installKind === initialized.status.installKind &&
    !params.signal.aborted &&
    updateCampaign.getState()?.state !== "applying";
  if (!isCurrent()) {
    return;
  }
  const {
    installStatus,
    channel: configuredChannel,
    readOnlySchedule,
  } = await prepareStartupUpdateInstall(
    () => Promise.resolve(initialized),
    configChannel,
    params.signal,
  );
  if (!isCurrent()) {
    return;
  }
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
  const schedule = getUpdateSchedule();
  const channelChanged = schedule !== null && schedule.channel !== configuredChannel;
  if (channelChanged) {
    updateCampaign.clear();
  }
  const priorSchedule = schedule?.channel === configuredChannel ? schedule : null;
  const initialSchedule: UpdateScheduleState = priorSchedule
    ? { ...priorSchedule, autoEnabled }
    : { channel: configuredChannel, autoEnabled };
  const { root, status, installReceipt } = installStatus;
  const isDevGit = configuredChannel === "dev" && status.installKind === "git";
  // Cached checks still publish the installation facts discovery already established.
  setSchedule(
    withUpdateInstallStatus(
      autoDesired ? initialSchedule : withoutUpdateCampaign(initialSchedule),
      status,
      isDevGit,
      installReceipt,
      root,
    ),
  );
  if (!autoDesired) {
    updateCampaign.clear();
  }

  if (configuredChannel === "extended-stable") {
    if (installStatus.status.installKind !== "package") {
      updateCampaign.clear();
      setAvailable(null);
      setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
      return;
    }
  }

  const shouldRunAutoUpdate =
    autoDesired && (configuredChannel === "stable" || configuredChannel === "beta" || isDevGit);
  if (!shouldRunAutoUpdate) {
    updateCampaign.clear();
  }
  const telemetryUpdate = await checkTelemetryUpdate(params.getConfig);
  params.signal?.throwIfAborted();
  const state = await readState();
  if (!isCurrent()) {
    return;
  }
  const rawNow = Date.now();
  const now = resolveUpdateCheckNowMs(rawNow);
  const rawNowIsValid = asDateTimestampMs(rawNow) !== undefined;
  const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
  const recentAttempt = hasRecentAutoAttempt(cfg, lastAttemptAt, now);
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  const persistedAvailable = isDevGit
    ? null
    : resolvePersistedUpdateAvailable(state, configuredChannel);
  const cacheMatchesChannel = state.lastCheckedChannel === configuredChannel;
  // Stable discovery without auto-update reads the shared telemetry cache; a release
  // newer than the one already published must not wait out the daily throttle.
  const hasNewTelemetryRelease =
    !shouldRunAutoUpdate &&
    configuredChannel === "stable" &&
    (compareSemverStrings(
      persistedAvailable?.latestVersion ?? VERSION,
      telemetryUpdate?.version ?? null,
    ) ?? 0) < 0;
  const scheduledWindow = shouldRunAutoUpdate ? autoScheduleWindow(cfg, now) : undefined;
  const shouldBypassSharedThrottle =
    isDevGit ||
    !cacheMatchesChannel ||
    hasNewTelemetryRelease ||
    (shouldRunAutoUpdate &&
      scheduledWindow !== undefined &&
      (!lastCheckedAt || lastCheckedAt < scheduledWindow));
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
    const update = await resolveDevGitUpdate(status, params.signal);
    if (!isCurrent()) {
      return;
    }
    lifecycle.installStatus = installStatus;
    if (!update) {
      updateCampaign.clear();
      setAvailable(null);
      setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
      await writeState(nextState);
      return;
    }
    const { git, target, available } = update;
    const { upstreamSha } = target;
    if (!updateCampaign.reconcileTarget(target)) {
      return;
    }
    setAvailable(available);
    setSchedule({ ...(getUpdateSchedule() ?? initialSchedule), target });

    if (autoEnabled && autoDisabledByExternalSupervisor) {
      params.log.info("auto-update delegated to external supervisor", {
        version: upstreamSha,
        tag: "dev",
        reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      });
    }
    if (shouldRunAutoUpdate && canRunDevGitCampaign(git)) {
      if (!recentAttempt) {
        announceUpdate(target, installStatus, "dev", "dev");
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
  const resolved: Awaited<ReturnType<typeof resolveNpmChannelTag>> =
    shouldRunAutoUpdate || channel !== "stable"
      ? await resolveNpmChannelTag({ channel, signal: params.signal })
      : {
          tag: "latest",
          version: telemetryUpdate?.version ?? null,
        };
  params.signal?.throwIfAborted();
  if (!isCurrent()) {
    return;
  }
  // A failed registry observation cannot advance the successful-check throttle
  // or erase a previously observed update. Missing selectors remain valid absence.
  const registryFailure =
    resolved.error ?? (resolved.reason === "selector_missing" ? undefined : resolved.reason);
  if (registryFailure) {
    throw new Error(`npm ${resolved.tag} update check failed: ${registryFailure}`);
  }
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
        announceUpdate(target, installStatus, channel, tag);
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
