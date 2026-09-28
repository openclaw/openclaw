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

type TelemetryUpdateOptions = {
  surface: TelemetrySurface;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  nowMs?: number;
};

const TelemetryResponseSchema = z.object({
  version: z.string().trim().min(1),
  note: z.string().optional(),
});

let lastFailedAttempt: { at: number; endpoint: string; stateDirectory?: string } | undefined;
type TelemetryCheckOutcome = {
  update: TelemetryUpdate | null;
  networkAttempted: boolean;
};
let inFlightUpdate: Promise<TelemetryCheckOutcome> | undefined;
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
 * pipeline should not report to us on every job either. A configured endpoint
 * means the caller is deliberately exercising this path, so it still reports.
 */
function isAutomatedEnvironment(): boolean {
  if (process.env.OPENCLAW_TELEMETRY_ENDPOINT?.trim()) {
    return false;
  }
  return isTruthyEnvValue(process.env.CI);
}

function isUpdateCheckDisabled(config: OpenClawConfig): boolean {
  return (
    config.update?.checkOnStart === false ||
    isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE) ||
    isAutomatedEnvironment() ||
    resolveIsNixMode()
  );
}

function isDoNotTrackEnabled(): boolean {
  const value = process.env.DO_NOT_TRACK?.trim().toLowerCase();
  return value === "1" || value === "true";
}

async function countRecentSessions(context: TelemetryStorage, nowMs: number): Promise<number> {
  if (!context.worker) {
    return 0;
  }
  try {
    return (
      (await runOpenClawStateWorkerOperation(
        context.worker,
        (scope) =>
          scope.execute({
            type: "telemetry.countRecentSessions",
            input: { sinceMs: nowMs - TELEMETRY_CHECK_INTERVAL_MS },
          }),
        { existingOnly: true },
      )) ?? 0
    );
  } catch {
    return 0;
  }
}

function resolveTelemetryEndpoint(): string {
  return process.env.OPENCLAW_TELEMETRY_ENDPOINT?.trim() || DEFAULT_TELEMETRY_ENDPOINT;
}

export function buildTelemetryUserAgent(surface: TelemetrySurface): string {
  return `openclaw/${VERSION} (${process.platform}; node/${process.versions.node}; ${process.arch}; ${surface})`;
}

async function readTelemetryState(context: TelemetryStorage): Promise<TelemetryState> {
  if (!context.worker) {
    return {};
  }
  try {
    return (
      (await runOpenClawStateWorkerOperation(
        context.worker,
        (scope) => scope.execute({ type: "telemetry.readState", input: undefined }),
        { existingOnly: true },
      )) ?? {}
    );
  } catch {
    return {};
  }
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
  if (pendingSuccesses.size > TELEMETRY_PENDING_SUCCESS_LIMIT) {
    const oldestKey = pendingSuccesses.keys().next().value;
    if (oldestKey !== undefined) {
      pendingSuccesses.delete(oldestKey);
    }
  }
  return state;
}

export async function resolveTelemetryStatus(config: OpenClawConfig): Promise<{
  enabled: boolean;
  reason: TelemetryStatusReason;
  endpoint: string;
  lastPingAt?: number;
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
      sessionsLast24h: await countRecentSessions(context, Date.now()),
    },
  };
}

export async function checkTelemetryUpdate(
  getConfig: () => OpenClawConfig,
  options: TelemetryUpdateOptions,
): Promise<TelemetryUpdate | null> {
  const config = getConfig();
  if (isUpdateCheckDisabled(config)) {
    return null;
  }

  const precedingCheck = inFlightUpdate;
  const endpoint = resolveTelemetryEndpoint();
  const context = captureTelemetryStorage();
  const pendingKey = JSON.stringify([endpoint, context.databasePath]);
  const nowMs = options.nowMs ?? Date.now();
  const stateDirectory = process.env.OPENCLAW_STATE_DIR;
  const check = async (
    preceding: Promise<TelemetryCheckOutcome> | undefined,
  ): Promise<TelemetryCheckOutcome> => {
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
      state.lastPingAt !== undefined &&
      nowMs >= state.lastPingAt &&
      nowMs - state.lastPingAt < TELEMETRY_CHECK_INTERVAL_MS
    ) {
      return { update: cached, networkAttempted: false };
    }
    if (
      !options.fetchImpl &&
      (process.env.VITEST !== undefined || process.env.NODE_ENV === "test")
    ) {
      return { update: cached, networkAttempted: false };
    }
    if (
      lastFailedAttempt?.endpoint === endpoint &&
      lastFailedAttempt.stateDirectory === stateDirectory &&
      nowMs >= lastFailedAttempt.at &&
      nowMs - lastFailedAttempt.at < TELEMETRY_FAILURE_BACKOFF_MS
    ) {
      return { update: cached, networkAttempted: false };
    }
    if (preceding) {
      const outcome = await preceding;
      if (outcome.networkAttempted) {
        return outcome;
      }
      const current = inFlightUpdate;
      if (!current) {
        inFlightUpdate = pendingCheck;
      }
      return await check(current);
    }
    let networkAttempted = false;

    try {
      const featureStatsEnabled = config.telemetry?.enabled === true && !isDoNotTrackEnabled();
      const headers: Record<string, string> = {
        "User-Agent": buildTelemetryUserAgent(options.surface),
      };
      const init: RequestInit = {
        method: featureStatsEnabled ? "POST" : "GET",
        headers,
      };
      if (featureStatsEnabled) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(
          await prepareTelemetryPayload(config, { surface: options.surface }, context),
        );
      }
      const currentConfig = getConfig();
      if (isUpdateCheckDisabled(currentConfig)) {
        return { update: cached, networkAttempted };
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
      networkAttempted = true;
      const response = await (options.fetchImpl ?? fetch)(endpoint, init);
      if (response.status !== 200) {
        lastFailedAttempt = { at: nowMs, endpoint, stateDirectory };
        return { update: cached, networkAttempted };
      }
      const parsed = TelemetryResponseSchema.parse(
        await readProviderJsonResponse(response, "Telemetry update response"),
      );
      const note = parsed.note?.trim().slice(0, TELEMETRY_NOTE_MAX_LENGTH);
      const update = {
        version: parsed.version,
        ...(note ? { note } : {}),
      };
      const persisted = await persistTelemetrySuccess(
        pendingKey,
        {
          lastPingAt: nowMs,
          latestVersion: update.version,
          ...(update.note ? { note: update.note } : {}),
        },
        context,
      );
      lastFailedAttempt = undefined;
      return {
        update: {
          version: persisted.latestVersion,
          ...(persisted.note ? { note: persisted.note } : {}),
        },
        networkAttempted,
      };
    } catch {
      lastFailedAttempt = { at: nowMs, endpoint, stateDirectory };
      return { update: cached, networkAttempted };
    }
  };

  // Publish completion only after the owning slot is released; a cached result is not a request.
  const pendingCheck = check(precedingCheck).finally(() => {
    if (inFlightUpdate === pendingCheck) {
      inFlightUpdate = undefined;
    }
  });
  if (!precedingCheck) {
    inFlightUpdate = pendingCheck;
  }
  return (await pendingCheck).update;
}
