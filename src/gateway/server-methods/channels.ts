import {
  type ChannelsStartParams,
  ErrorCodes,
  errorShape,
  validateChannelsStartParams,
  validateChannelsStopParams,
  validateChannelsLogoutParams,
  validateChannelsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import { redactChannelStatusSummaryBaseUrl } from "../../channels/account-snapshot-fields.js";
import { buildChannelAccountSnapshotFromRuntime } from "../../channels/account-summary.js";
import { buildChannelUiCatalog } from "../../channels/plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { buildChannelAccountSnapshotFromAccount } from "../../channels/plugins/status.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { resolveUnavailableChannelAccountSnapshot } from "../../channels/status/account-state.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  resolveChannelHealthState,
} from "../channel-health-policy.js";
import { formatForLog } from "../ws-log.js";
import {
  logoutChannelAccount,
  resolveChannelGatewayAccountId,
  type ChannelAccountParams,
  resolveRuntimeAccountSnapshot,
} from "./channels-account.js";
import {
  collectGatewayChannelStatusIssues,
  resolveDeferredChannelReloadIssue,
} from "./channels-status-issues.js";
import { respondUnavailableOnThrow } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandler, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

type ChannelOperationParams = {
  channel?: unknown;
  accountId?: unknown;
};

function resolveChannelOperationParams<TParams extends ChannelOperationParams>(params: {
  method: "channels.start" | "channels.stop" | "channels.logout";
  rawParams: unknown;
  respond: RespondFn;
  validate: Validator<TParams>;
}): { params: TParams; channelId: ChannelId; plugin: ChannelPlugin } | null {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.method, params.respond)) {
    return null;
  }
  const rawChannel = rawParams.channel;
  const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
  if (!channelId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${params.method} channel`),
    );
    return null;
  }
  const plugin = getChannelPlugin(channelId);
  if (!plugin) {
    const message =
      params.method === "channels.start"
        ? `unknown channel: ${formatForLog(rawChannel)}`
        : params.method === "channels.stop"
          ? `unknown channel ${channelId}`
          : `channel ${channelId} does not support logout`;
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    return null;
  }
  const unsupported =
    params.method === "channels.start" && !plugin.gateway?.startAccount
      ? "start"
      : params.method === "channels.logout" && !plugin.gateway?.logoutAccount
        ? "logout"
        : undefined;
  if (unsupported) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `channel ${channelId} does not support ${unsupported}`,
      ),
    );
    return null;
  }
  return { params: rawParams, channelId, plugin };
}

async function respondWithChannelOperationPayload<TPayload>(params: {
  respond: RespondFn;
  run: () => Promise<TPayload>;
}): Promise<void> {
  await respondUnavailableOnThrow(params.respond, async () => {
    params.respond(true, await params.run(), undefined);
  });
}

function channelAccountOperationHandler(
  method: "channels.start" | "channels.stop",
  validate: Validator<ChannelsStartParams>,
  run: (params: ChannelAccountParams) => Promise<unknown>,
): GatewayRequestHandler {
  return async ({ params, respond, context }) => {
    const resolved = resolveChannelOperationParams({
      method,
      rawParams: params,
      respond,
      validate,
    });
    if (!resolved) {
      return;
    }
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        run({
          channelId: resolved.channelId,
          accountId: resolved.params.accountId,
          cfg: context.getRuntimeConfig(),
          context,
          plugin: resolved.plugin,
        }),
    });
  };
}

const CHANNEL_STATUS_MAX_TIMEOUT_MS = 30_000;
const CHANNEL_STATUS_PROBE_CONCURRENCY = 5;

type TimeoutRaceResult<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

async function raceWithTimeout<T>(params: {
  timeoutMs: number;
  run: () => Promise<T> | T;
}): Promise<TimeoutRaceResult<T>> {
  const timeoutMs = params.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });
  const result = await Promise.race([
    Promise.resolve()
      .then(params.run)
      .then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
    timeout,
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

type ChannelStatusResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; timedOut?: boolean };

async function runChannelStatusHook(params: {
  accountId?: string;
  channelId: ChannelId;
  step: "audit" | "probe" | "summary";
  timeoutMs: number;
  warnings: string[];
  run: () => unknown;
}): Promise<ChannelStatusResult> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  // Plugin hooks can be slow or fail independently; keep the remaining status usable.
  const result = await raceWithTimeout({ timeoutMs, run: params.run });
  if (result.kind === "value") {
    return { ok: true, value: result.value };
  }
  const warningPrefix = `${params.channelId}${params.accountId === undefined ? "" : `:${params.accountId}`} ${params.step}`;
  if (result.kind === "timeout") {
    params.warnings.push(`${warningPrefix} timed out after ${timeoutMs}ms`);
    return { ok: false, timedOut: true, error: `${params.step} timed out after ${timeoutMs}ms` };
  }
  const message = formatForLog(result.error);
  params.warnings.push(`${warningPrefix} failed: ${message}`);
  return { ok: false, error: message };
}

function channelStatusFailureMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.ok !== false || typeof record.error !== "string" || record.error.length === 0) {
    return null;
  }
  return record.error;
}

function resolveChannelsStatusTimeoutMs(params: { probe: boolean; timeoutMsRaw: unknown }): number {
  const fallback = params.probe ? CHANNEL_STATUS_MAX_TIMEOUT_MS : 10_000;
  if (typeof params.timeoutMsRaw !== "number" || !Number.isFinite(params.timeoutMsRaw)) {
    return fallback;
  }
  return Math.min(Math.max(1000, params.timeoutMsRaw), CHANNEL_STATUS_MAX_TIMEOUT_MS);
}

async function startChannelAccount(params: ChannelAccountParams) {
  if (!params.plugin.gateway?.startAccount) {
    throw new Error(`Channel ${params.channelId} does not support runtime start`);
  }
  const resolvedAccountId = resolveChannelGatewayAccountId(params, () =>
    params.context.getRuntimeSnapshot({ channelId: params.channelId, inspectAccounts: false }),
  );
  const outcomes = await params.context.startChannel(params.channelId, resolvedAccountId, {
    manual: true,
  });
  const outcome = outcomes.get(resolvedAccountId);
  if (!outcome) {
    throw new Error(
      `Channel ${params.channelId} did not report a start outcome for ${resolvedAccountId}`,
    );
  }
  const runtime = params.context.getRuntimeSnapshot({
    channelId: params.channelId,
    inspectAccounts: false,
  });
  const started =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running === true;
  const deferredIssue = resolveDeferredChannelReloadIssue(
    params.context,
    params.channelId,
    resolvedAccountId,
  );
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    started,
    outcome,
    ...(deferredIssue ? { statusIssues: [deferredIssue] } : {}),
  };
}

async function stopChannelAccount(params: ChannelAccountParams) {
  const resolvedAccountId = resolveChannelGatewayAccountId(params, () =>
    params.context.getRuntimeSnapshot({ channelId: params.channelId, inspectAccounts: false }),
  );
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const runtime = params.context.getRuntimeSnapshot({
    channelId: params.channelId,
    inspectAccounts: false,
  });
  const stopped =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running !== true;
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    stopped,
  };
}

export const channelsHandlers: GatewayRequestHandlers = {
  "channels.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateChannelsStatusParams, "channels.status", respond)) {
      return;
    }
    const probe = params.probe === true;
    const timeoutMs = resolveChannelsStatusTimeoutMs({ probe, timeoutMsRaw: params.timeoutMs });
    const rawChannel = params.channel;
    const cfg = context.getRuntimeConfig();
    const plugins = listReadOnlyChannelPluginsForConfig(cfg);
    const requestedChannel =
      typeof rawChannel === "string"
        ? (normalizeChannelId(rawChannel) ??
          plugins.find((plugin) => plugin.id === rawChannel.trim().toLowerCase())?.id)
        : undefined;
    const selectedPlugins = requestedChannel
      ? plugins.filter((plugin) => plugin.id === requestedChannel)
      : plugins;
    // Preserve registry-defined UI order while stabilizing keyed status maps for prompt-cache input.
    const statusPlugins = selectedPlugins.toSorted((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    if (rawChannel !== undefined && !requestedChannel) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel: ${formatForLog(rawChannel)}`),
      );
      return;
    }
    const runtime = context.getRuntimeSnapshot({ channelId: requestedChannel });
    const statusWarnings: string[] = [];

    const buildAccountSnapshot = async (
      channelId: ChannelId,
      plugin: ChannelPlugin,
      accountId: string,
      listed: boolean,
    ) => {
      const runtimeSnapshot = resolveRuntimeAccountSnapshot({ runtime, channelId, accountId });
      if (!listed && runtimeSnapshot) {
        const snapshot = buildChannelAccountSnapshotFromRuntime(runtimeSnapshot);
        return {
          accountId,
          snapshot:
            resolveUnavailableChannelAccountSnapshot(cfg, {
              channelId,
              accountId,
              runtime: snapshot,
            }) ?? snapshot,
        };
      }
      const unavailable = resolveUnavailableChannelAccountSnapshot(cfg, {
        channelId,
        accountId,
        runtime: runtimeSnapshot,
      });
      const diagnosticSnapshot =
        unavailable ?? (runtimeSnapshot?.enabled === false ? runtimeSnapshot : undefined);
      if (diagnosticSnapshot) {
        return { accountId, snapshot: diagnosticSnapshot };
      }
      const account = await resolveChannelAccount({ plugin, cfg, accountId });
      const enabled = plugin.config.isEnabled?.(account, cfg) ?? isAccountEnabled(account);
      let probeResult: unknown;
      let lastProbeAt: number | null = null;
      if (probe && enabled && plugin.status?.probeAccount) {
        // Skip expensive probes for accounts that are not configured; the
        // snapshot builder still reports the config state below.
        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (configured) {
          const result = await runChannelStatusHook({
            channelId,
            accountId,
            step: "probe",
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.probeAccount!({
                account,
                timeoutMs,
                cfg,
              }),
          });
          probeResult = result.ok ? result.value : result;
          lastProbeAt = Date.now();
        }
      }
      let auditResult: unknown;
      if (probe && enabled && plugin.status?.auditAccount) {
        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (configured) {
          const result = await runChannelStatusHook({
            channelId,
            accountId,
            step: "audit",
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.auditAccount!({
                account,
                timeoutMs,
                cfg,
                probe: probeResult,
              }),
          });
          auditResult = result.ok ? result.value : result;
        }
      }
      const snapshot = await buildChannelAccountSnapshotFromAccount({
        plugin,
        cfg,
        accountId,
        account,
        runtime: runtimeSnapshot,
        probe: probeResult,
        audit: auditResult,
      });
      const hookError =
        channelStatusFailureMessage(auditResult) ?? channelStatusFailureMessage(probeResult);
      if (hookError && !snapshot.lastError) {
        snapshot.lastError = hookError;
      }
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }
      const activity = getChannelActivity({
        channel: channelId as never,
        accountId,
      });
      if (snapshot.lastInboundAt == null) {
        snapshot.lastInboundAt = activity.inboundAt;
      }
      if (snapshot.lastOutboundAt == null) {
        snapshot.lastOutboundAt = activity.outboundAt;
      }
      const healthState = resolveChannelHealthState(snapshot, {
        channelId,
        now: Date.now(),
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      });
      if (healthState !== undefined) {
        snapshot.healthState = healthState;
      }
      return { accountId, account, snapshot };
    };

    const buildChannelAccounts = async (plugin: ChannelPlugin) => {
      const channelId = plugin.id;
      if (runtime.reloadingChannels?.has(channelId)) {
        const defaultAccount = runtime.channels[channelId];
        statusWarnings.push(
          `${channelId}: plugin runtime is paused for reload; reporting recorded account state`,
        );
        return {
          accounts: Object.values(runtime.channelAccounts[channelId] ?? {}),
          defaultAccountId: runtime.reloadingChannels.get(channelId) ?? DEFAULT_ACCOUNT_ID,
          defaultAccount,
          resolvedAccounts: {},
        };
      }
      const configuredAccountIds = plugin.config.listAccountIds(cfg);
      const configuredAccountIdSet = new Set(configuredAccountIds);
      const accountIds = [
        ...new Set([
          ...configuredAccountIds,
          ...Object.keys(runtime.channelAccounts[channelId] ?? {}),
        ]),
      ];
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds: configuredAccountIds,
      });
      const resolvedAccounts: Record<string, unknown> = {};
      const { results } = await runTasksWithConcurrency({
        tasks: accountIds.map(
          (accountId) => async () =>
            await buildAccountSnapshot(
              channelId,
              plugin,
              accountId,
              configuredAccountIdSet.has(accountId),
            ),
        ),
        limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : accountIds.length || 1,
        onTaskError: (error, index) => {
          const accountId = accountIds[index] ?? `account ${index + 1}`;
          statusWarnings.push(`${channelId}:${accountId} status failed: ${formatForLog(error)}`);
        },
      });
      const accounts: ChannelAccountSnapshot[] = [];
      for (const result of results) {
        if (result) {
          if ("account" in result) {
            resolvedAccounts[result.accountId] = result.account;
          }
          accounts.push(result.snapshot);
        }
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ??
        accounts.find((entry) => configuredAccountIdSet.has(entry.accountId));
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(selectedPlugins);
    const channelsMap: Record<string, unknown> = {};
    const accountsMap: Record<string, ChannelAccountSnapshot[]> = {};
    const defaultAccountIdMap: Record<string, string> = {};
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      ...(context.getEventLoopHealth ? { eventLoop: context.getEventLoopHealth() } : {}),
      channels: channelsMap,
      channelAccounts: accountsMap,
      channelDefaultAccountId: defaultAccountIdMap,
    };
    const { results: channelResults } = await runTasksWithConcurrency({
      tasks: statusPlugins.map((plugin) => async () => {
        const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
          await buildChannelAccounts(plugin);
        const fallbackSummary = (lastError = defaultAccount?.lastError) => ({
          configured: defaultAccount?.configured ?? false,
          ...(lastError ? { lastError } : {}),
        });
        let summary: unknown = fallbackSummary();
        if (
          plugin.status?.buildChannelSummary &&
          Object.hasOwn(resolvedAccounts, defaultAccountId)
        ) {
          const summaryResult = await runChannelStatusHook({
            step: "summary",
            channelId: plugin.id,
            timeoutMs,
            warnings: statusWarnings,
            run: () =>
              plugin.status!.buildChannelSummary!({
                account: resolvedAccounts[defaultAccountId],
                cfg,
                defaultAccountId,
                snapshot: defaultAccount ?? { accountId: defaultAccountId },
              }),
          });
          summary = summaryResult.ok
            ? redactChannelStatusSummaryBaseUrl(summaryResult.value)
            : fallbackSummary(summaryResult.error);
        }
        return { pluginId: plugin.id, summary, accounts, defaultAccountId };
      }),
      limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : selectedPlugins.length || 1,
      onTaskError: (error, index) => {
        const channelId = statusPlugins[index]?.id ?? `channel ${index + 1}`;
        statusWarnings.push(`${channelId} channel status failed: ${formatForLog(error)}`);
      },
    });
    for (const result of channelResults) {
      if (result) {
        channelsMap[result.pluginId] = result.summary;
        accountsMap[result.pluginId] = result.accounts;
        defaultAccountIdMap[result.pluginId] = result.defaultAccountId;
      }
    }
    payload.statusIssues = collectGatewayChannelStatusIssues({
      payload,
      plugins: statusPlugins,
      reloadingChannels: runtime.reloadingChannels,
      defaultAccountIds: defaultAccountIdMap,
      context,
      warnings: statusWarnings,
    });
    if (statusWarnings.length > 0) {
      payload.partial = true;
      payload.warnings = statusWarnings.toSorted().slice(0, 50);
    }

    respond(true, payload, undefined);
  },
  "channels.start": channelAccountOperationHandler(
    "channels.start",
    validateChannelsStartParams,
    startChannelAccount,
  ),
  "channels.stop": channelAccountOperationHandler(
    "channels.stop",
    validateChannelsStopParams,
    stopChannelAccount,
  ),
  "channels.logout": async (invocation) => {
    const { params, respond, context } = invocation;
    const resolved = resolveChannelOperationParams({
      method: "channels.logout",
      rawParams: params,
      respond,
      validate: validateChannelsLogoutParams,
    });
    if (!resolved) {
      return;
    }
    const { params: parsedParams, channelId, plugin } = resolved;
    const accountId = parsedParams.accountId;
    const methodRegistry = context.getGatewayMethodRegistry?.();
    const requestAuthority = readGatewayRequestMutationAuthority(invocation);
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        logoutChannelAccount({
          channelId,
          accountId,
          cfg: context.getRuntimeConfig(),
          context,
          plugin,
          methodRegistry,
          assertRequestCurrent: requestAuthority.assertCurrent,
        }),
    });
  },
};
