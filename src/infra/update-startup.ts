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
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
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
import {
  prepareStartupUpdateInstall,
  resolveStartupInstallStatus,
  withUpdateInstallStatus,
} from "./update-install-status.js";
import type { AutoUpdateRunner } from "./update-startup-auto-run.js";
import { createUpdateCampaignPublisher } from "./update-startup-campaign.js";
import { scheduleGatewayRemoteCatalogChecks } from "./update-startup-catalog.js";
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

function shouldSkipCheck(allowInTests: boolean): boolean {
  return !allowInTests && Boolean(process.env.VITEST || process.env.NODE_ENV === "test");
}

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

function readState(): UpdateCheckState {
  return readConfigMachineState<UpdateCheckState>(UPDATE_CHECK_STATE_KEY) ?? {};
}

function writeState(state: UpdateCheckState): void {
  writeConfigMachineState(UPDATE_CHECK_STATE_KEY, state);
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
  if (shouldSkipCheck(Boolean(params.allowInTests))) {
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
  const generation = ++lifecycle.publicationGeneration;
  const cfg = params.getConfig();
  const configChannel = normalizeUpdateChannel(cfg.update?.channel);
  const runAuto: AutoUpdateRunner =
    params.runAutoUpdate ??
    (async (runParams) => {
      const { runAutoUpdateCommand } = await import("./update-startup-auto-run.js");
      return runAutoUpdateCommand(runParams, params.log);
    });
  const announceUpdate = createUpdateCampaignPublisher({
    ...params,
    lifecycle,
    campaign: updateCampaign,
    runAuto,
    onAttempt: recordAutoUpdateAttempt,
    setSchedule,
  });
  const announceDevGitUpdate: NonNullable<UpdateCheckLifecycle["announceDevGitUpdate"]> = (
    target,
    installStatus,
  ) => {
    const state = readState();
    const lastAttemptAt = state.autoLastAttemptAt ? Date.parse(state.autoLastAttemptAt) : null;
    if (
      lastAttemptAt != null &&
      Number.isFinite(lastAttemptAt) &&
      resolveUpdateCheckNowMs(Date.now()) - lastAttemptAt < ONE_HOUR_MS
    ) {
      return;
    }
    announceUpdate(target, installStatus, "dev", "dev");
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
  const initialChannel = resolveEffectiveUpdateChannel({
    configChannel,
    currentVersion: VERSION,
    ...initialized.status,
  }).channel;
  const isCurrent = () =>
    lifecycle.isCurrent() &&
    lifecycle.installStatus?.status.installKind === initialized.status.installKind &&
    resolveEffectiveUpdateChannel({
      configChannel: normalizeUpdateChannel(params.getConfig().update?.channel),
      currentVersion: VERSION,
      ...initialized.status,
    }).channel === initialChannel &&
    !params.signal.aborted &&
    updateCampaign.getState()?.state !== "applying" &&
    generation === lifecycle.publicationGeneration;
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
  setSchedule(autoDesired ? initialSchedule : withoutUpdateCampaign(initialSchedule));
  if (!autoDesired) {
    updateCampaign.clear();
  }

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
  if (!isCurrent()) {
    return;
  }
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
    Number.isFinite(lastCheckedAt)
  ) {
    if (now - lastCheckedAt < checkIntervalMs) {
      return;
    }
  }

  const { root, status, installReceipt } = installStatus;
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
    const update = await resolveDevGitUpdate(status, params.signal);
    if (!isCurrent()) {
      return;
    }
    lifecycle.publicationGeneration += 1;
    if (!update) {
      updateCampaign.clear();
      setAvailable(null);
      setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
      writeState(nextState);
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
      announceDevGitUpdate(target, installStatus);
    } else {
      updateCampaign.clear();
    }
    writeState(nextState);
    return;
  }

  if (status.installKind !== "package") {
    clearAvailabilityState(nextState);
    clearAutoState(nextState);
    setAvailable(null);
    updateCampaign.clear();
    setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
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
  if (!isCurrent()) {
    return;
  }
  const tag = resolved.tag;
  if (!resolved.version) {
    if (channel === "extended-stable") {
      clearAvailabilityState(nextState);
      setAvailable(null);
      updateCampaign.clear();
      setSchedule(withoutUpdateTarget(getUpdateSchedule() ?? initialSchedule));
    }
    writeState(nextState);
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

  writeState(nextState);
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
      scheduleGatewayRemoteCatalogChecks(params);
    },
  };
}
