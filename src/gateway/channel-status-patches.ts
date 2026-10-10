// Channel status patch factories centralize timestamp fields that multiple
// runtime paths send into the gateway status store.
import { isChannelIngressUnavailableError } from "../channels/message/ingress-unavailable.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";
import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
import { isPluginTrustRefusalError } from "../plugins/plugin-trust.js";

type ReadyChannelStatusPatch = {
  running: true;
  connected: true;
  lifecycle: "ready";
  lastConnectedAt: number;
  lastError: null;
  terminalDisconnect: undefined;
};

type BlockedChannelStatusPatch = {
  lifecycle: "blocked";
  terminalDisconnect: true;
  lastError: string;
};

type StoppedChannelStatusPatch = {
  running: false;
  connected: false;
  lifecycle: "stopped";
};

type ReadyChannelStatusExtras = Partial<
  Omit<ChannelAccountSnapshot, keyof ReadyChannelStatusPatch>
> & {
  lastConnectedAt?: number;
};
type BlockedChannelStatusExtras = Partial<
  Omit<ChannelAccountSnapshot, keyof BlockedChannelStatusPatch>
>;
type StoppedChannelStatusExtras = Partial<
  Omit<ChannelAccountSnapshot, keyof StoppedChannelStatusPatch>
>;

/** Creates a connected-channel status patch with matching connection/event timestamps. */
export function createConnectedChannelStatusPatch(at: number = Date.now()) {
  return {
    connected: true as const,
    lastConnectedAt: at,
    lastEventAt: at,
  };
}

/** Creates a transport-activity patch for health/activity monitors. */
export function createTransportActivityStatusPatch(at: number = Date.now()) {
  return {
    lastTransportActivityAt: at,
  };
}

/** Creates a ready patch that clears any retained terminal-auth verdict. */
export function channelReadyPatch(): ReadyChannelStatusPatch;
export function channelReadyPatch<TExtras extends ReadyChannelStatusExtras>(
  extras: TExtras,
): ReadyChannelStatusPatch & TExtras;
export function channelReadyPatch(
  extras: ReadyChannelStatusExtras = {},
): ReadyChannelStatusPatch & ReadyChannelStatusExtras {
  return {
    running: true,
    connected: true,
    lifecycle: "ready",
    lastConnectedAt: Date.now(),
    lastError: null,
    terminalDisconnect: undefined,
    ...extras,
  };
}

/** Creates a terminal blocked patch with a required operator-facing error. */
export function channelBlockedPatch(lastError: string): BlockedChannelStatusPatch;
export function channelBlockedPatch<TExtras extends BlockedChannelStatusExtras>(
  lastError: string,
  extras: TExtras,
): BlockedChannelStatusPatch & TExtras;
export function channelBlockedPatch(
  lastError: string,
  extras: BlockedChannelStatusExtras = {},
): BlockedChannelStatusPatch & BlockedChannelStatusExtras {
  return {
    lifecycle: "blocked",
    terminalDisconnect: true,
    lastError,
    ...extras,
  };
}

/** Classifies startup failures before transport cleanup or retry policy can hide their cause. */
export function channelStartFailurePatch(error: unknown): Omit<
  ChannelAccountSnapshot,
  "accountId"
> & {
  lastError: string;
} {
  const lastError = formatErrorMessage(error);
  const trustRefused = isPluginTrustRefusalError(error);
  return {
    lastError,
    ...(extractErrorCode(error) === "AGENT_SELECTION_REQUIRED" || trustRefused
      ? channelBlockedPatch(lastError, trustRefused ? { healthState: "plugin-trust-refused" } : {})
      : {}),
    ...(isChannelIngressUnavailableError(error) ? { ingressUnavailable: true } : {}),
  };
}

/** Creates the shared patch emitted after a channel account has stopped. */
export function channelStoppedPatch(): StoppedChannelStatusPatch;
export function channelStoppedPatch<TExtras extends StoppedChannelStatusExtras>(
  extras: TExtras,
): StoppedChannelStatusPatch & TExtras;
export function channelStoppedPatch(
  extras: StoppedChannelStatusExtras = {},
): StoppedChannelStatusPatch & StoppedChannelStatusExtras {
  return {
    running: false,
    connected: false,
    lifecycle: "stopped",
    ...extras,
  };
}

export function sanitizeAbortedTaskStatusPatch(
  patch: ChannelAccountSnapshot,
  current: ChannelAccountSnapshot,
): ChannelAccountSnapshot {
  const next = { ...patch };
  delete next.running;
  delete next.restartPending;
  delete next.reconnectAttempts;
  delete next.lastStartAt;
  delete next.lastStopAt;
  delete next.lifecycle;

  // A stale task may still emit a late "connected" heartbeat after the gateway
  // has already aborted it and marked restart recovery pending. Do not let that
  // old task make the stopped runtime look connected again.
  if (next.connected === true) {
    delete next.connected;
    delete next.lastConnectedAt;
    delete next.lastEventAt;
    delete next.lastTransportActivityAt;
  }

  // Preserve actionable lifecycle diagnostics (for example a stop-timeout
  // recovery error) against late stale-task status patches that merely clear
  // plugin transport errors.
  if (next.lastError === null && current.lastError) {
    delete next.lastError;
  }

  return next;
}
