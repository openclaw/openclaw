import path from "node:path";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { isChannelConfigMetadataKey } from "../channels/config-metadata.js";
import { isBuiltInModelProviderOverlayId } from "../config/model-provider-overlay-ids.js";
import { resolveIsNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOfficialExternalProviderPluginIds } from "../plugins/official-external-plugin-catalog.js";
import { isPubliclyKnownPluginId } from "../plugins/plugin-public-identity.js";
import { listEnabledPluginRecords } from "../plugins/plugin-runtime-inventory.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import { pruneMapToMaxSize } from "./map-size.js";
import {
  INSTALLATION_COUNT_HEADER,
  INSTALLATION_COUNT_USER_AGENT,
  parseInstallationCountCapability,
} from "./telemetry-installation-count.js";
import type { TelemetryWorkerOperations } from "./telemetry-store.worker.js";
import type { SuccessfulTelemetryState, TelemetryState } from "./telemetry-worker-contract.js";

const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.openclaw.ai/api/latest-version";
const TELEMETRY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TELEMETRY_FAILURE_BACKOFF_MS = 60 * 1000;
const TELEMETRY_TIMEOUT_MS = 3000;
const TELEMETRY_NOTE_MAX_LENGTH = 500;
const TELEMETRY_PENDING_SUCCESS_LIMIT = 32;
const SAFE_FEATURE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

type TelemetrySurface = "gateway" | "cli";

type TelemetryUpdate = {
  version: string;
  note?: string;
};

type TelemetryPayload = {
  schema: 1;
  version: string;
  platform: string;
  node: string;
  surface: TelemetrySurface;
  features: {
    channels: string[];
    providerFamilies: string[];
    plugins: string[];
    pluginsEnabled: number;
    sessionsLast24h: number;
  };
};

type TelemetryStatusReason =
  | "enabled"
  | "automated-environment"
  | "do-not-track"
  | "config-disabled"
  | "never-asked"
  | "update-disabled";

const TelemetryResponseSchema = z.object({
  version: z.string().trim().min(1),
  note: z.string().optional(),
});

let lastFailedAttempt: { at: number; endpoint: string; stateDirectory?: string } | undefined;
const inFlightUpdates = new Map<string, Promise<TelemetryUpdate | null>>();
const pendingSuccesses = new Map<string, SuccessfulTelemetryState>();

type TelemetryStorage = { databasePath: string; worker?: OpenClawStateWorkerContext };

function captureTelemetryStorage(): TelemetryStorage {
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath());
  try {
    return { databasePath, worker: captureOpenClawStateWorkerContext({ path: databasePath }) };
  } catch {
    // Storage admission failures retain the same best-effort read and success-cache behavior.
    return { databasePath };
  }
}

/**
 * CI jobs are not installs. Left unchecked they outnumber operators by orders of
 * magnitude and make version and platform counts meaningless, and someone else's
 * pipeline should not report to us on every job either. Custom test receivers
 * can exercise the path in CI, but explicitly naming production is not an opt-in.
 */
function isAutomatedEnvironment(endpoint = resolveTelemetryEndpoint()): boolean {
  if (!isTruthyEnvValue(process.env.CI)) {
    return false;
  }
  try {
    return (
      new URL(endpoint).hostname.replace(/\.$/, "") === new URL(DEFAULT_TELEMETRY_ENDPOINT).hostname
    );
  } catch {
    return true;
  }
}

function isUpdateCheckDisabled(
  config: OpenClawConfig,
  endpoint = resolveTelemetryEndpoint(),
): boolean {
  return (
    config.update?.checkOnStart === false ||
    isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE) ||
    isAutomatedEnvironment(endpoint) ||
    resolveIsNixMode()
  );
}

function isInstallationCountEnabled(config: OpenClawConfig): boolean {
  return (
    !isDoNotTrackEnabled() &&
    (config.telemetry?.enabled === true ||
      (config.telemetry?.enabled !== false && !config.telemetry?.consentedAt))
  );
}

async function reportInstallationCount(
  context: TelemetryStorage,
  endpoint: string,
  day: number,
  getConfig: () => OpenClawConfig,
): Promise<void> {
  try {
    const config = getConfig();
    if (
      !context.worker ||
      isUpdateCheckDisabled(config, endpoint) ||
      !isInstallationCountEnabled(config)
    ) {
      return;
    }
    const count = await runOpenClawStateWorkerOperation(context.worker, (scope) =>
      scope.execute({ type: "telemetry.claimInstallationCount", input: { endpoint, day } }),
    );
    const currentConfig = getConfig();
    if (
      count === null ||
      isUpdateCheckDisabled(currentConfig, endpoint) ||
      !isInstallationCountEnabled(currentConfig)
    ) {
      return;
    }
    // This independent, payload-free request cannot enter the receiver's raw update analytics.
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "User-Agent": INSTALLATION_COUNT_USER_AGENT, [INSTALLATION_COUNT_HEADER]: count },
      redirect: "error",
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    // A lost count must never discard a valid version response or retry an ambiguous attempt.
  }
}

function isDoNotTrackEnabled(): boolean {
  const value = process.env.DO_NOT_TRACK?.trim().toLowerCase();
  return value === "1" || value === "true";
}

async function readTelemetry<Type extends "telemetry.readState" | "telemetry.countRecentSessions">(
  context: TelemetryStorage,
  type: Type,
  input: TelemetryWorkerOperations[Type]["input"],
  fallback: TelemetryWorkerOperations[Type]["output"],
): Promise<TelemetryWorkerOperations[Type]["output"]> {
  if (!context.worker) {
    return fallback;
  }
  try {
    return (
      (await runOpenClawStateWorkerOperation(
        context.worker,
        (scope) => scope.execute({ type, input }),
        { existingOnly: true },
      )) ?? fallback
    );
  } catch {
    // Optional local telemetry storage must not prevent the update check.
    return fallback;
  }
}

function resolveTelemetryEndpoint(): string {
  return process.env.OPENCLAW_TELEMETRY_ENDPOINT?.trim() || DEFAULT_TELEMETRY_ENDPOINT;
}

export function buildTelemetryUserAgent(): string {
  return `openclaw/${VERSION} (${process.platform}; node/${process.versions.node}; ${process.arch}; gateway)`;
}

function readTelemetryState(context: TelemetryStorage): Promise<TelemetryState> {
  return readTelemetry(context, "telemetry.readState", undefined, {});
}

async function persistTelemetrySuccess(
  key: string,
  state: SuccessfulTelemetryState,
  context: TelemetryStorage,
): Promise<SuccessfulTelemetryState> {
  const updatedAtMs = Date.now();
  if (context.worker) {
    try {
      return await runOpenClawStateWorkerOperation(context.worker, async (scope) => {
        const persisted = await scope.execute({
          type: "telemetry.persistSuccess",
          input: { state, updatedAtMs },
        });
        pendingSuccesses.delete(key);
        return persisted;
      });
    } catch {
      // Retain the accepted response below when its local write fails.
    }
  }
  // A failed local write must not discard an accepted response or trigger another daily report.
  pendingSuccesses.delete(key);
  pendingSuccesses.set(key, state);
  pruneMapToMaxSize(pendingSuccesses, TELEMETRY_PENDING_SUCCESS_LIMIT);
  return state;
}

export async function resolveTelemetryStatus(config: OpenClawConfig): Promise<{
  enabled: boolean;
  reason: TelemetryStatusReason;
  endpoint: string;
  lastPingAt?: number;
  installationCountEnabled: boolean;
}> {
  let reason: TelemetryStatusReason;
  if (isAutomatedEnvironment()) {
    reason = "automated-environment";
  } else if (isUpdateCheckDisabled(config)) {
    reason = "update-disabled";
  } else if (isDoNotTrackEnabled()) {
    reason = "do-not-track";
  } else if (config.telemetry?.enabled === true) {
    reason = "enabled";
  } else if (config.telemetry?.enabled === false || config.telemetry?.consentedAt) {
    reason = "config-disabled";
  } else {
    reason = "never-asked";
  }

  const endpoint = resolveTelemetryEndpoint();
  const { lastPingAt } = await readTelemetryState(captureTelemetryStorage());
  return {
    enabled: reason === "enabled",
    reason,
    endpoint,
    ...(lastPingAt === undefined ? {} : { lastPingAt }),
    installationCountEnabled:
      !isUpdateCheckDisabled(config, endpoint) && isInstallationCountEnabled(config),
  };
}

export async function buildTelemetryPayload(
  config: OpenClawConfig,
  options: { surface: TelemetrySurface },
): Promise<TelemetryPayload> {
  return await prepareTelemetryPayload(config, options, captureTelemetryStorage());
}

async function prepareTelemetryPayload(
  config: OpenClawConfig,
  options: { surface: TelemetrySurface },
  context: TelemetryStorage,
): Promise<TelemetryPayload> {
  const enabledPlugins = listEnabledPluginRecords(config);
  const publicPlugins = enabledPlugins.filter(isPubliclyKnownPluginId);
  const publicChannelIds = new Set(publicPlugins.flatMap((plugin) => plugin.channelIds));
  const channels = Object.entries(config.channels ?? {})
    .filter(
      ([channelId, channelConfig]) =>
        SAFE_FEATURE_NAME.test(channelId) &&
        !isChannelConfigMetadataKey(channelId) &&
        isRecord(channelConfig) &&
        channelConfig.enabled !== false &&
        publicChannelIds.has(channelId),
    )
    .map(([channelId]) => channelId)
    .toSorted();
  const configuredProviders = [
    ...Object.keys(config.models?.providers ?? {}),
    ...Object.values(config.auth?.profiles ?? {}).map((profile) => profile.provider),
    ...collectConfiguredModelRefs(config, { includeChannelModelOverrides: false }).flatMap(
      ({ value }) => {
        const provider = parseModelCatalogRef(value)?.provider;
        return provider ? [provider] : [];
      },
    ),
  ];
  const providerFamilies = [...new Set(configuredProviders.map(normalizeProviderId))]
    .filter(
      (providerId) =>
        SAFE_FEATURE_NAME.test(providerId) &&
        (isBuiltInModelProviderOverlayId(providerId) ||
          resolveOfficialExternalProviderPluginIds({ providerIds: new Set([providerId]) }).length >
            0),
    )
    .toSorted();
  const plugins = [...new Set(publicPlugins.map((plugin) => plugin.id))]
    .filter((pluginId) => SAFE_FEATURE_NAME.test(pluginId))
    .toSorted();

  return {
    schema: 1,
    version: VERSION,
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    surface: options.surface,
    features: {
      channels,
      providerFamilies,
      plugins,
      pluginsEnabled: enabledPlugins.length,
      sessionsLast24h: await readTelemetry(
        context,
        "telemetry.countRecentSessions",
        { sinceMs: Date.now() - TELEMETRY_CHECK_INTERVAL_MS },
        0,
      ),
    },
  };
}

export async function checkTelemetryUpdate(
  getConfig: () => OpenClawConfig,
): Promise<TelemetryUpdate | null> {
  const config = getConfig();
  if (isUpdateCheckDisabled(config)) {
    return null;
  }

  const endpoint = resolveTelemetryEndpoint();
  const context = captureTelemetryStorage();
  const pendingKey = JSON.stringify([
    endpoint,
    context.worker?.admission.coordinationKey ?? context.databasePath,
  ]);
  const inFlight = inFlightUpdates.get(pendingKey);
  if (inFlight) {
    return inFlight;
  }
  const nowMs = Date.now();
  const stateDirectory = process.env.OPENCLAW_STATE_DIR;
  const check = async (): Promise<TelemetryUpdate | null> => {
    let state = await readTelemetryState(context);
    const pending = pendingSuccesses.get(pendingKey);
    if (pending) {
      if (state.lastPingAt === undefined || pending.lastPingAt > state.lastPingAt) {
        state = await persistTelemetrySuccess(pendingKey, pending, context);
      } else {
        pendingSuccesses.delete(pendingKey);
      }
    }
    const cached = state.latestVersion
      ? { version: state.latestVersion, ...(state.note ? { note: state.note } : {}) }
      : null;
    if (
      (state.lastPingAt !== undefined &&
        nowMs >= state.lastPingAt &&
        nowMs - state.lastPingAt < TELEMETRY_CHECK_INTERVAL_MS) ||
      process.env.VITEST !== undefined ||
      process.env.NODE_ENV === "test" ||
      (lastFailedAttempt?.endpoint === endpoint &&
        lastFailedAttempt.stateDirectory === stateDirectory &&
        nowMs >= lastFailedAttempt.at &&
        nowMs - lastFailedAttempt.at < TELEMETRY_FAILURE_BACKOFF_MS)
    ) {
      return cached;
    }

    try {
      const dispatchConfig = getConfig();
      if (isUpdateCheckDisabled(dispatchConfig, endpoint)) {
        return cached;
      }
      const featureStatsEnabled =
        dispatchConfig.telemetry?.enabled === true && !isDoNotTrackEnabled();
      const headers: Record<string, string> = {
        "User-Agent": buildTelemetryUserAgent(),
      };
      const init: RequestInit = {
        method: featureStatsEnabled ? "POST" : "GET",
        headers,
      };
      if (featureStatsEnabled) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(
          await prepareTelemetryPayload(dispatchConfig, { surface: "gateway" }, context),
        );
      }
      const currentConfig = getConfig();
      if (isUpdateCheckDisabled(currentConfig, endpoint)) {
        return cached;
      }
      if (
        featureStatsEnabled &&
        (currentConfig.telemetry?.enabled !== true || isDoNotTrackEnabled())
      ) {
        init.method = "GET";
        delete headers["Content-Type"];
        delete init.body;
      }
      init.signal = AbortSignal.timeout(TELEMETRY_TIMEOUT_MS);
      // A CI test receiver must not forward update or feature reports to production.
      init.redirect = isTruthyEnvValue(process.env.CI) ? "error" : "follow";
      const response = await fetch(endpoint, init);
      if (response.status === 200) {
        const countDay = parseInstallationCountCapability(
          response.headers.get(INSTALLATION_COUNT_HEADER),
        );
        const parsed = TelemetryResponseSchema.parse(
          await readProviderJsonResponse(response, "Telemetry update response"),
        );
        const note = parsed.note?.trim().slice(0, TELEMETRY_NOTE_MAX_LENGTH);
        const persisted = await persistTelemetrySuccess(
          pendingKey,
          {
            lastPingAt: nowMs,
            latestVersion: parsed.version,
            ...(note ? { note } : {}),
          },
          context,
        );
        lastFailedAttempt = undefined;
        if (countDay !== null && !response.redirected) {
          await reportInstallationCount(context, endpoint, countDay, getConfig);
        }
        return {
          version: persisted.latestVersion,
          ...(persisted.note ? { note: persisted.note } : {}),
        };
      }
    } catch {
      // A failed check keeps the previous accepted update.
    }
    lastFailedAttempt = { at: nowMs, endpoint, stateDirectory };
    return cached;
  };

  // Only callers for the same endpoint and physical installation share a check.
  const checking = check().finally(() => {
    inFlightUpdates.delete(pendingKey);
  });
  inFlightUpdates.set(pendingKey, checking);
  return checking;
}
