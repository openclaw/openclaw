import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway.ts";

export type CustodianEventNudge = {
  severity: 1 | 2 | 3;
  kind: "channel-auth" | "channel-degraded" | "channel-disconnected" | "config-reload";
  channelLabel?: string;
  message: string;
};

export type CustodianSendDelivery = "unsent" | "sent" | "received";
export type CustodianSendOutcome = "sent" | "rejected" | "unknown";

export async function sendCustodianEventNudge(
  owner: {
    eventNudge: CustodianEventNudge | null;
    eventNudgePending: CustodianEventNudge | null;
    eventNudgeClosed: boolean;
    readonly sensitive: boolean;
    hasUnresolvedQuestion(): boolean;
    send(text: string): Promise<CustodianSendOutcome>;
  },
  notify: () => void,
): Promise<void> {
  const nudge = owner.eventNudge;
  if (!nudge || owner.sensitive || owner.hasUnresolvedQuestion()) {
    return;
  }
  owner.eventNudgePending = nudge;
  notify();
  const outcome = await owner.send(nudge.message);
  if (owner.eventNudgePending === nudge) {
    owner.eventNudgePending = null;
    const consumed =
      outcome !== "rejected" &&
      owner.eventNudge !== null &&
      owner.eventNudge.severity === nudge.severity &&
      owner.eventNudge.message === nudge.message;
    [owner.eventNudgeClosed, owner.eventNudge] = [consumed, consumed ? null : owner.eventNudge];
    notify();
  }
}

export function classifyCustodianSendFailure(
  error: unknown,
  delivery: CustodianSendDelivery,
): CustodianSendOutcome {
  if (delivery === "received") {
    return "sent";
  }
  if (error instanceof GatewayRequestError || delivery === "unsent") {
    return "rejected";
  }
  return "unknown";
}

export function questionUncertainty(previous: boolean, outcome: CustodianSendOutcome): boolean {
  if (outcome === "sent") {
    return false;
  }
  return outcome === "unknown" ? true : previous;
}

type UnknownRecord = Record<string, unknown>;

const CONSEQUENTIAL_CHANNEL_STATES = new Set([
  "disconnected",
  "stale-socket",
  "stuck",
  "terminal-disconnect",
]);
const CHANNEL_AUTH_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

function classifyChannelAccount(
  channelId: string,
  label: string,
  account: UnknownRecord,
): CustodianEventNudge | null {
  if (account.configured === false || account.enabled === false) {
    return null;
  }
  const canonical = channelId.toLowerCase();
  if (CHANNEL_AUTH_STATUS_KEYS.some((key) => account[key] === "configured_unavailable")) {
    return {
      severity: 3,
      kind: "channel-auth",
      channelLabel: label,
      message: `what happened with ${canonical} authentication?`,
    };
  }
  const degraded: CustodianEventNudge = {
    severity: 3,
    kind: "channel-degraded",
    channelLabel: label,
    message: `what happened with ${canonical}?`,
  };
  const healthState =
    typeof account.healthState === "string" ? account.healthState.trim().toLowerCase() : undefined;
  if (healthState === "terminal-disconnect" || asRecord(account.probe)?.ok === false) {
    return degraded;
  }
  if (healthState === "not-running" && account.running === false) {
    const reconnectAttempts =
      typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : 0;
    const lastStartAt = typeof account.lastStartAt === "number" ? account.lastStartAt : undefined;
    const lastStopAt = typeof account.lastStopAt === "number" ? account.lastStopAt : undefined;
    if (
      account.restartPending === false &&
      lastStopAt !== undefined &&
      (lastStartAt === undefined || lastStopAt >= lastStartAt) &&
      reconnectAttempts < 10
    ) {
      // server-channels only leaves this low-count, non-retrying shape after a clean/manual stop.
      // A newer start timestamp means a pre-handoff startup failed after an earlier clean stop.
      return null;
    }
  }
  if (
    account.connected !== true &&
    healthState !== "healthy" &&
    typeof account.lastError === "string" &&
    account.lastError.trim()
  ) {
    return degraded;
  }
  if (account.connected === false && account.running === true) {
    return { ...degraded, severity: 2, kind: "channel-disconnected" };
  }
  if (healthState && CONSEQUENTIAL_CHANNEL_STATES.has(healthState)) {
    return { ...degraded, severity: 1 };
  }
  return null;
}

export function classifyCustodianHealthNudge(payload: unknown): CustodianEventNudge | null {
  const health = asRecord(payload);
  if (!health) {
    return null;
  }
  if (asRecord(health.configReload)?.hotReloadStatus === "disabled") {
    return {
      severity: 3,
      kind: "config-reload",
      message: "what happened with configuration reload?",
    };
  }
  const channels = asRecord(health.channels);
  if (!channels) {
    return null;
  }
  const labels = asRecord(health.channelLabels);
  let best: CustodianEventNudge | null = null;
  for (const [channelId, channelValue] of Object.entries(channels)) {
    const channel = asRecord(channelValue);
    if (!channel) {
      continue;
    }
    const label = typeof labels?.[channelId] === "string" ? labels[channelId] : channelId;
    const accounts = asRecord(channel.accounts);
    const accountCandidates = accounts
      ? Object.values(accounts)
          .map(asRecord)
          .filter((value) => value !== null)
      : [];
    // The channel-level record duplicates the preferred account. Per-account
    // rows are authoritative when present and may have different enabled state.
    const candidates = accountCandidates.length > 0 ? accountCandidates : [channel];
    for (const account of candidates) {
      const nudge = classifyChannelAccount(channelId, label, account);
      if (nudge && (!best || nudge.severity > best.severity)) {
        best = nudge;
      }
    }
  }
  return best;
}
