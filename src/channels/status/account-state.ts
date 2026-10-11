import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { redactToolPayloadTextWithConfig } from "../../logging/redact.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "../../secrets/runtime-degraded-state.js";
import { isChannelAccountExplicitlyDisabled } from "../account-config-enabled.js";
import type { ChannelAccountLinkState } from "../plugins/types.adapters.js";
import type {
  ChannelAccountSnapshot,
  ChannelAccountState as ChannelAccountDisplayState,
} from "../plugins/types.core.js";

type ChannelAccountState = {
  snapshot: Pick<ChannelAccountSnapshot, (typeof CHANNEL_ACCOUNT_STATE_FIELDS)[number]>;
  displayState?: ChannelAccountDisplayState;
};

type ChannelAccountStateInput = {
  enabled: boolean;
  configured: boolean;
  linked: boolean | undefined;
  runtime?: Pick<ChannelAccountSnapshot, "running" | "connected" | "lastError">;
  disabledReason?: string;
  unconfiguredReason?: string;
  unlinkedReason?: string;
};

export function resolveUnavailableChannelAccountSnapshot(
  cfg: OpenClawConfig,
  params: {
    channelId: string;
    accountId: string;
    runtime?: ChannelAccountSnapshot;
    registry?: PluginRegistry;
  },
): ChannelAccountSnapshot | undefined {
  const accountId = normalizeAccountId(params.accountId);
  const owner = findActiveDegradedSecretOwner("account", `${params.channelId}:${accountId}`);
  const registry = params.registry ?? getActivePluginRegistry();
  const failedPlugin =
    !registry?.channels.some(({ plugin }) => plugin.id === params.channelId) &&
    registry?.plugins.find(
      (plugin) =>
        plugin.enabled && plugin.status === "error" && plugin.channelIds.includes(params.channelId),
    );
  // Read-scoped status must redact loader text before truncation can split a credential.
  const pluginError =
    failedPlugin &&
    redactToolPayloadTextWithConfig(
      `Plugin ${failedPlugin.id} failed: ${failedPlugin.error}`,
      cfg.logging,
    );
  // Cold owners have no operational account to resolve or probe. Stale owners
  // retain usable credentials and are excluded by the secrets runtime lookup.
  const lastError = owner
    ? new SecretSurfaceUnavailableError(owner).message
    : pluginError && `${truncateUtf16Safe(pluginError, 1_000)}; run openclaw doctor`;
  if (!lastError) {
    return undefined;
  }
  // Failed plugins have no live account: discard old probes/activity, but preserve config disables.
  const runtime = failedPlugin ? undefined : params.runtime;
  return {
    ...runtime,
    accountId: params.accountId,
    enabled: failedPlugin
      ? !isChannelAccountExplicitlyDisabled({ cfg, channel: params.channelId, accountId })
      : (runtime?.enabled ?? true),
    configured: true,
    running: false,
    ...(typeof runtime?.connected === "boolean" ? { connected: false } : {}),
    restartPending: false,
    lifecycle: "blocked",
    stateReason: lastError,
    lastError,
  };
}

export function resolveChannelAccountState(input: ChannelAccountStateInput): ChannelAccountState {
  const lastError = input.runtime?.lastError ?? null;
  if (!input.enabled) {
    return {
      displayState: "disabled",
      snapshot: {
        configured: input.configured,
        ...(typeof input.linked === "boolean" ? { linked: input.linked } : {}),
        running: false,
        stateReason: input.disabledReason ?? "disabled",
        lastError,
      },
    };
  }
  if (!input.configured || input.linked === false) {
    return {
      displayState: input.configured ? "not linked" : "not configured",
      snapshot: {
        configured: input.configured,
        ...(input.configured ? { linked: false } : {}),
        running: false,
        stateReason: input.configured
          ? (input.unlinkedReason ?? "not linked")
          : (input.unconfiguredReason ?? "not configured"),
        lastError,
      },
    };
  }
  return {
    displayState: input.linked ? "linked" : undefined,
    snapshot: {
      configured: true,
      ...(input.linked ? { linked: true } : {}),
      running: input.runtime?.running === true,
      // An absent connectivity signal is not a disconnect for socketless transports.
      ...(typeof input.runtime?.connected === "boolean"
        ? { connected: input.runtime.connected }
        : {}),
      lastError,
    },
  };
}

export function resolveChannelAccountLinked(
  state: ChannelAccountLinkState | undefined,
  fallback?: boolean,
): boolean | undefined {
  return state ? (state === "unknown" ? undefined : state === "linked") : fallback;
}

const CHANNEL_ACCOUNT_STATE_FIELDS = [
  "configured",
  "linked",
  "running",
  "connected",
  "stateReason",
  "lastError",
] as const;

export function applyChannelAccountState(
  snapshot: ChannelAccountSnapshot,
  state: ChannelAccountState,
): void {
  for (const field of CHANNEL_ACCOUNT_STATE_FIELDS) {
    delete snapshot[field];
  }
  Object.assign(snapshot, state.snapshot);
}

export function projectChannelAccountDisplayState(
  state: ChannelAccountState,
  fallback?: ChannelAccountDisplayState,
): ChannelAccountDisplayState {
  return state.displayState ?? fallback ?? "configured";
}
