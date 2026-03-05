import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import type {
  ChannelAccountHealthSummary,
  ChannelHealthSummary,
  HealthSummary,
} from "../../commands/health.js";
import { getStatusSummary } from "../../commands/status.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";
const RUNTIME_MIRROR_FIELDS = [
  "running",
  "connected",
  "reconnectAttempts",
  "lastConnectedAt",
  "lastDisconnect",
  "lastMessageAt",
  "lastEventAt",
  "lastError",
  "lastStartAt",
  "lastStopAt",
] as const;

type RuntimeMirrorField = (typeof RUNTIME_MIRROR_FIELDS)[number];

function mergeRuntimeFields(
  base: ChannelAccountHealthSummary,
  runtime?: ChannelAccountSnapshot,
): ChannelAccountHealthSummary {
  if (!runtime) {
    return base;
  }
  let changed = false;
  const next: ChannelAccountHealthSummary = { ...base };
  for (const field of RUNTIME_MIRROR_FIELDS) {
    const runtimeValue = runtime[field as RuntimeMirrorField];
    if (runtimeValue === undefined) {
      continue;
    }
    if (next[field] === runtimeValue) {
      continue;
    }
    next[field] = runtimeValue;
    changed = true;
  }
  return changed ? next : base;
}

function mergeRuntimeSnapshot(
  summary: HealthSummary,
  runtime: ChannelRuntimeSnapshot,
): HealthSummary {
  const runtimeChannels = runtime.channels ?? {};
  const runtimeAccounts = runtime.channelAccounts ?? {};
  let channels = summary.channels;
  let changed = false;

  for (const [channelId, runtimeChannel] of Object.entries(runtimeChannels)) {
    const currentChannel = channels[channelId];
    if (!currentChannel || !runtimeChannel) {
      continue;
    }
    let nextChannel = mergeRuntimeFields(currentChannel, runtimeChannel) as ChannelHealthSummary;
    const accountRuntimeMap = runtimeAccounts[channelId];
    if (accountRuntimeMap && Object.keys(accountRuntimeMap).length > 0) {
      const currentAccounts = currentChannel.accounts ?? {};
      let nextAccounts = currentAccounts;
      for (const [accountId, runtimeAccount] of Object.entries(accountRuntimeMap)) {
        if (!runtimeAccount) {
          continue;
        }
        const currentAccount = currentAccounts[accountId] ?? { accountId };
        const mergedAccount = mergeRuntimeFields(currentAccount, runtimeAccount);
        if (mergedAccount === currentAccount) {
          continue;
        }
        if (nextAccounts === currentAccounts) {
          nextAccounts = { ...currentAccounts };
        }
        nextAccounts[accountId] = mergedAccount;
      }
      if (nextAccounts !== currentAccounts) {
        if (nextChannel === currentChannel) {
          nextChannel = { ...nextChannel };
        }
        nextChannel.accounts = nextAccounts;
      }
    }
    if (nextChannel !== currentChannel) {
      if (!changed) {
        channels = { ...channels };
        changed = true;
      }
      channels[channelId] = nextChannel;
    }
  }

  return changed ? { ...summary, channels } : summary;
}

export const healthHandlers: GatewayRequestHandlers = {
  health: async ({ respond, context, params }) => {
    const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
    const runtime = context.getRuntimeSnapshot();
    const wantsProbe = params?.probe === true;
    const now = Date.now();
    const cached = getHealthCache();
    if (!wantsProbe && cached && now - cached.ts < HEALTH_REFRESH_INTERVAL_MS) {
      respond(true, mergeRuntimeSnapshot(cached, runtime), undefined, { cached: true });
      void refreshHealthSnapshot({ probe: false }).catch((err) =>
        logHealth.error(`background health refresh failed: ${formatError(err)}`),
      );
      return;
    }
    try {
      const snap = await refreshHealthSnapshot({ probe: wantsProbe });
      respond(true, mergeRuntimeSnapshot(snap, runtime), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  status: async ({ respond, client }) => {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const status = await getStatusSummary({
      includeSensitive: scopes.includes(ADMIN_SCOPE),
    });
    respond(true, status, undefined);
  },
};
