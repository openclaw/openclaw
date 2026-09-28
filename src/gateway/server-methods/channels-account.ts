// Account selection, logout, and runtime lookup for channel lifecycle and status RPCs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveRuntimeAccountSnapshot(params: {
  runtime: ChannelRuntimeSnapshot;
  channelId: ChannelId;
  accountId: string;
}): ChannelAccountSnapshot | undefined {
  const accounts = params.runtime.channelAccounts[params.channelId];
  const direct = accounts?.[params.accountId];
  if (direct) {
    return direct;
  }
  const fallback = params.runtime.channels[params.channelId];
  return fallback?.accountId === params.accountId ? fallback : undefined;
}

export function resolveChannelGatewayAccountId(
  params: {
    plugin: ChannelPlugin;
    cfg: OpenClawConfig;
    accountId?: string | null;
  },
  getRuntimeSnapshot?: () => ChannelRuntimeSnapshot,
): string {
  const explicit = normalizeOptionalString(params.accountId);
  if (explicit) {
    return explicit;
  }
  const channelId = params.plugin.id;
  // Explicit account controls must not inspect unrelated configured accounts.
  const runtime = getRuntimeSnapshot?.();
  // Paused controls use recorded selection without entering a quiesced plugin.
  if (runtime?.reloadingChannels?.has(channelId)) {
    return (
      runtime.reloadingChannels.get(channelId) ||
      Object.keys(runtime.channelAccounts[channelId] ?? {})[0] ||
      DEFAULT_ACCOUNT_ID
    );
  }
  // Outside reload, preserve setup's default-account precedence.
  return (
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID
  );
}

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

export type ChannelAccountParams = {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
};

/** Log out one channel account through its owning channel plugin. */
export async function logoutChannelAccount(
  params: ChannelAccountParams & {
    methodRegistry: GatewayMethodRegistry | undefined;
    assertRequestCurrent: () => void;
  },
): Promise<ChannelLogoutPayload> {
  const isRuntimeCurrent = () =>
    params.context.getGatewayMethodRegistry?.() === params.methodRegistry &&
    (!params.methodRegistry ||
      getPluginRuntimeGatewayRequestScope()?.pluginRegistry ===
        params.methodRegistry.pluginRegistry) &&
    params.context.getRuntimeConfig() === params.cfg &&
    params.context.isConfigReloadSettled();
  const assertCurrent = () => {
    params.assertRequestCurrent();
    if (!isRuntimeCurrent()) {
      throw new Error(`Channel ${params.channelId} changed during logout; retry the request.`);
    }
  };
  assertCurrent();
  // Credential removal uses current config rather than a paused runtime's older inventory.
  const resolvedAccountId = resolveChannelGatewayAccountId(params);
  const account = await resolveChannelAccount({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: resolvedAccountId,
  });
  assertCurrent();
  // Stop the runtime before clearing channel-owned auth so no active watcher can
  // immediately reconnect with credentials the user is trying to remove.
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  assertCurrent();
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  params.assertRequestCurrent();
  if (!result) {
    throw new Error(`Channel ${params.channelId} does not support logout`);
  }
  const cleared = result.cleared;
  const loggedOut = typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  // Logout may publish new config; its completed result must not mark a replacement runtime.
  if (loggedOut && isRuntimeCurrent()) {
    params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
  }
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}
