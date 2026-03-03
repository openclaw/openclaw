import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import { getHealthSnapshot, type HealthSummary } from "../../commands/health.js";
import { CONFIG_PATH, STATE_DIR, loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable } from "../../infra/update-startup.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAuth } from "../auth.js";
import type { Snapshot } from "../protocol/index.js";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;
let healthRuntimeSnapshotProvider: (() => ChannelRuntimeSnapshot) | null = null;

export function buildGatewaySnapshot(): Snapshot {
  const cfg = loadConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const mainSessionKey = resolveMainSessionKey(cfg);
  const scope = cfg.session?.scope ?? "per-sender";
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
  const updateAvailable = getUpdateAvailable() ?? undefined;
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  return {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    // Surface resolved paths so UIs can display the true config location.
    configPath: CONFIG_PATH,
    stateDir: STATE_DIR,
    sessionDefaults: {
      defaultAgentId,
      mainKey,
      mainSessionKey,
      scope,
    },
    authMode: auth.mode,
    updateAvailable,
  };
}

export function getHealthCache(): HealthSummary | null {
  return healthCache;
}

export function getHealthVersion(): number {
  return healthVersion;
}

export function incrementPresenceVersion(): number {
  presenceVersion += 1;
  return presenceVersion;
}

export function getPresenceVersion(): number {
  return presenceVersion;
}

export function setBroadcastHealthUpdate(fn: ((snap: HealthSummary) => void) | null) {
  broadcastHealthUpdate = fn;
}

export function setHealthRuntimeSnapshotProvider(fn: (() => ChannelRuntimeSnapshot) | null) {
  healthRuntimeSnapshotProvider = fn;
}

export async function overlayHealthSnapshotWithRuntime(
  snapshot: HealthSummary,
): Promise<HealthSummary> {
  if (!healthRuntimeSnapshotProvider) {
    return snapshot;
  }

  const cfg = loadConfig();
  const runtime = healthRuntimeSnapshotProvider();
  const pluginMap = new Map(listChannelPlugins().map((plugin) => [plugin.id, plugin]));
  const nextChannels: HealthSummary["channels"] = {};

  for (const [channelId, channelSummary] of Object.entries(snapshot.channels ?? {})) {
    const plugin = pluginMap.get(channelId);
    if (!plugin) {
      nextChannels[channelId] = channelSummary;
      continue;
    }

    const accountEntries =
      channelSummary.accounts && typeof channelSummary.accounts === "object"
        ? channelSummary.accounts
        : {};
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const accountIdsToOverlay = Array.from(
      new Set(
        [defaultAccountId, ...accountIds, ...Object.keys(accountEntries)].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        ),
      ),
    );

    const mergedAccounts: NonNullable<typeof channelSummary.accounts> = {};
    for (const accountId of accountIdsToOverlay) {
      const previous =
        accountEntries[accountId] && typeof accountEntries[accountId] === "object"
          ? accountEntries[accountId]
          : { accountId };
      const runtimeSnapshot =
        runtime.channelAccounts[channelId]?.[accountId] ??
        (accountId === defaultAccountId ? runtime.channels[channelId] : undefined);
      const overlay = await buildChannelAccountSnapshot({
        plugin,
        cfg,
        accountId,
        runtime: runtimeSnapshot,
        probe: previous.probe,
      });
      const nextAccount = {
        ...previous,
        ...overlay,
        accountId,
      };
      if (previous.probe !== undefined) {
        nextAccount.probe = previous.probe;
      }
      if (previous.lastProbeAt !== undefined) {
        nextAccount.lastProbeAt = previous.lastProbeAt;
      }
      mergedAccounts[accountId] = nextAccount;
    }

    const preferredAccountId = channelSummary.accountId ?? defaultAccountId;
    const defaultAccount =
      mergedAccounts[preferredAccountId] ??
      mergedAccounts[defaultAccountId] ??
      Object.values(mergedAccounts)[0] ??
      channelSummary;
    const nextChannel = {
      ...channelSummary,
      ...defaultAccount,
      accounts: mergedAccounts,
    };
    if (channelSummary.probe !== undefined) {
      nextChannel.probe = channelSummary.probe;
    }
    if (channelSummary.lastProbeAt !== undefined) {
      nextChannel.lastProbeAt = channelSummary.lastProbeAt;
    }
    nextChannels[channelId] = nextChannel;
  }

  return {
    ...snapshot,
    channels: nextChannels,
  };
}

export async function refreshGatewayHealthSnapshot(opts?: { probe?: boolean }) {
  if (!healthRefresh) {
    healthRefresh = (async () => {
      const snap = await overlayHealthSnapshotWithRuntime(
        await getHealthSnapshot({ probe: opts?.probe }),
      );
      healthCache = snap;
      healthVersion += 1;
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
      return snap;
    })().finally(() => {
      healthRefresh = null;
    });
  }
  return healthRefresh;
}
