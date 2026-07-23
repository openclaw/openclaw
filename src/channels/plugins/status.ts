/**
 * Channel status snapshot builders.
 *
 * Combines plugin status hooks, account inspection, and safe account field projection.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { inspectChannelAccount } from "../account-inspection.js";
import {
  projectSafeChannelAccountSnapshotFields,
  redactChannelAccountSnapshotBaseUrl,
} from "../account-snapshot-fields.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelAccountStatus, ChannelAccountSnapshotInput } from "./types.public.js";

export async function buildChannelAccountSnapshotFromAccount<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime?: ChannelAccountSnapshotInput;
  probe?: unknown;
  audit?: unknown;
  enabledFallback?: boolean;
  configuredFallback?: boolean;
}): Promise<ChannelAccountStatus> {
  let snapshot: ChannelAccountSnapshotInput;
  if (params.plugin.status?.buildAccountSnapshot) {
    snapshot = await params.plugin.status.buildAccountSnapshot({
      account: params.account,
      cfg: params.cfg,
      runtime: params.runtime,
      probe: params.probe,
      audit: params.audit,
    });
  } else {
    const enabled = params.plugin.config.isEnabled
      ? params.plugin.config.isEnabled(params.account, params.cfg)
      : params.account && typeof params.account === "object"
        ? (params.account as { enabled?: boolean }).enabled
        : undefined;
    const configured =
      params.account && typeof params.account === "object" && "configured" in params.account
        ? (params.account as { configured?: boolean }).configured
        : params.plugin.config.isConfigured
          ? await params.plugin.config.isConfigured(params.account, params.cfg)
          : undefined;
    snapshot = {
      accountId: params.accountId,
      enabled,
      configured,
      ...projectSafeChannelAccountSnapshotFields(params.account),
      ...projectSafeChannelAccountSnapshotFields(params.runtime),
    };
  }

  const projected = projectSafeChannelAccountSnapshotFields({
    ...snapshot,
  });
  const probe = snapshot.probe !== undefined ? snapshot.probe : params.probe;
  const audit = snapshot.audit !== undefined ? snapshot.audit : params.audit;
  return redactChannelAccountSnapshotBaseUrl({
    accountId: normalizeOptionalString(snapshot.accountId) ? snapshot.accountId : params.accountId,
    ...projected,
    enabled: projected.enabled ?? params.enabledFallback,
    configured: projected.configured ?? params.configuredFallback,
    ...(probe !== undefined ? { probe } : {}),
    ...(audit !== undefined ? { audit } : {}),
  });
}

export async function buildReadOnlySourceChannelAccountSnapshot<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountId: string;
  runtime?: ChannelAccountSnapshotInput;
  probe?: unknown;
  audit?: unknown;
}): Promise<ChannelAccountStatus | null> {
  const inspectedAccount = await inspectChannelAccount(params);
  if (!inspectedAccount) {
    return null;
  }
  return await buildChannelAccountSnapshotFromAccount({
    ...params,
    account: inspectedAccount as ResolvedAccount,
  });
}

export async function buildChannelAccountSnapshot<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountId: string;
  runtime?: ChannelAccountSnapshotInput;
  probe?: unknown;
  audit?: unknown;
}): Promise<ChannelAccountStatus> {
  const inspectedAccount = await inspectChannelAccount(params);
  const account = (inspectedAccount ??
    params.plugin.config.resolveAccount(params.cfg, params.accountId)) as ResolvedAccount;
  return await buildChannelAccountSnapshotFromAccount({
    ...params,
    account,
  });
}
