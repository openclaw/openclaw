import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
} from "../channel-health-policy.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { ReadinessChecker, StartupChecker } from "../server/readiness.js";
import type { GatewayHealthReadiness, HealthSummary, PluginHealthErrorSummary } from "./types.js";

/** Failed loading can precede activation; retain the configured activation intent. */
export function isRequiredPluginHealthError(plugin: PluginHealthErrorSummary): boolean {
  return (
    plugin.activated ||
    plugin.activationSource === "explicit" ||
    plugin.activationSource === "auto" ||
    plugin.activationSource === "default"
  );
}

/** Diagnostic projection, not a second admission or restart-policy owner. */
export function projectGatewayHealthReadiness(
  summary: HealthSummary,
  owners: {
    readiness?: ReturnType<ReadinessChecker>;
    startup?: ReturnType<StartupChecker>;
    runtime?: ChannelRuntimeSnapshot;
  } = {},
): GatewayHealthReadiness {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let starting = false;
  let degraded = false;
  let failed = false;
  const { readiness, startup } = owners;
  let observationsComplete = owners.runtime !== undefined || readiness?.channelsSkipped === true;
  if (startup?.status === "starting") {
    starting = true;
    reasons.push(startup.pendingReason);
  } else if (startup?.status === "draining") {
    degraded = true;
    reasons.push("gateway-draining");
  }
  if (readiness && !readiness.ready) {
    reasons.push(...readiness.failing);
    failed = Boolean(readiness.stateDatabase) || readiness.pluginReload?.phase === "failed";
    degraded ||= !starting && !failed;
  }
  if (summary.childRuntime?.available === false) {
    failed = true;
    reasons.push("child-runtime-unavailable");
  }
  if (summary.eventLoop?.degraded) {
    degraded = true;
    reasons.push("event-loop");
  }
  if (summary.modelRuntime?.degraded) {
    degraded = true;
    reasons.push("model-runtime");
  }
  for (const plugin of summary.plugins?.errors ?? []) {
    if (isRequiredPluginHealthError(plugin)) {
      degraded = true;
      reasons.push("plugin:" + plugin.id);
    }
  }
  for (const plugin of summary.plugins?.unavailable ?? []) {
    // Shipped update verification treats configured-unavailable plugins as warnings.
    warnings.push("plugin-unavailable:" + plugin.id);
  }
  const channelIds = new Set([
    ...Object.keys(summary.channels),
    ...Object.keys(owners.runtime?.channels ?? {}),
    ...Object.keys(owners.runtime?.channelAccounts ?? {}),
  ]);
  for (const channelId of channelIds) {
    const channel = summary.channels[channelId];
    const records = channel?.accounts ?? (channel ? { [channel.accountId]: channel } : {});
    const runtimeChannel = owners.runtime?.channels[channelId];
    const runtimeAccounts =
      owners.runtime?.channelAccounts[channelId] ??
      (runtimeChannel ? { [runtimeChannel.accountId]: runtimeChannel } : {});
    for (const accountId of new Set([...Object.keys(records), ...Object.keys(runtimeAccounts)])) {
      const runtimeAccount = runtimeAccounts[accountId];
      // A collection deadline or plugin summary cannot erase live lifecycle facts.
      const account = {
        ...records[accountId],
        ...runtimeAccount,
        accountId,
        // Lifecycle is live; probe results belong to this collection, not runtime patches.
        probe: records[accountId]?.probe,
      };
      if (account.enabled === false || account.configured === false || account.linked === false) {
        continue;
      }
      const key = "channel:" + channelId + ":" + account.accountId;
      const probe = asOptionalRecord(account.probe);
      if (probe?.timedOut === true) {
        warnings.push(key + ":probe-timeout");
      } else if (probe?.ok === false) {
        degraded = true;
        reasons.push(key + ":probe-failed");
      }
      if (readiness?.channelsSkipped) {
        warnings.push(key + ":readiness-skipped");
        continue;
      }
      const health = evaluateChannelHealth(account, {
        channelId,
        now: Date.now(),
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      });
      if (readiness?.suppressed?.includes(channelId) && health.reason === "not-running") {
        warnings.push(key + ":autostart-suppressed");
        continue;
      }
      if (runtimeAccount?.running === undefined && runtimeAccount?.lifecycle === undefined) {
        observationsComplete = false;
        reasons.push(key + ":observation-unavailable");
      }
      // Missing observations are uncertainty, not a stopped channel. Retained
      // diagnostics can report failure, but cannot certify current readiness.
      if (account.running === undefined && account.lifecycle === undefined) {
        continue;
      }
      if (
        (health.reason === "startup-connect-grace" &&
          (account.connected === false ||
            account.lifecycle === "starting" ||
            account.lifecycle === "recovering")) ||
        health.reason === "reconnect-grace" ||
        (account.restartPending === true && health.reason === "not-running")
      ) {
        starting = true;
        reasons.push(key + ":" + health.reason);
      } else if (
        health.healthy &&
        (account.lifecycle === "starting" || account.lifecycle === "recovering")
      ) {
        // Monitor grace can expire without a failure, but it cannot complete startup.
        starting = true;
        reasons.push(key + ":" + account.lifecycle);
      } else if (!health.healthy || account.connected === false) {
        degraded = true;
        reasons.push(key + ":" + (health.healthy ? "disconnected" : health.reason));
      }
    }
  }
  if (!readiness || !startup || !observationsComplete) {
    reasons.push("readiness-unavailable");
  }
  return {
    state: failed
      ? "failed"
      : degraded
        ? "degraded"
        : starting
          ? "starting"
          : readiness?.ready && startup?.status === "started" && observationsComplete
            ? "ready"
            : "reachable",
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
  };
}
