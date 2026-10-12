import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { inspectChannelAccount } from "../account-inspection.js";
import { describeChannelAccount, resolveChannelAccount } from "../account-resolution.js";
import {
  projectSafeChannelAccountSnapshotFields,
  redactChannelStatusSummaryBaseUrl,
} from "../account-snapshot-fields.js";
import { buildChannelAccountSnapshotFromInspection } from "../account-summary.js";
import {
  applyChannelAccountState,
  resolveChannelAccountLinked,
  resolveChannelAccountState,
  resolveUnavailableChannelAccountSnapshot,
} from "../status/account-state.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelAccountSnapshot } from "./types.public.js";

export async function buildChannelAccountSnapshotFromAccount<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount, unknown, unknown, 1 | 2>;
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime?: ChannelAccountSnapshot;
  probe?: unknown;
  audit?: unknown;
  enabledFallback?: boolean;
  configuredFallback?: boolean;
  assertActive?: () => void;
}): Promise<ChannelAccountSnapshot> {
  params.assertActive?.();
  let snapshot: ChannelAccountSnapshot;
  if (params.plugin.status?.buildAccountSnapshot) {
    snapshot = await params.plugin.status.buildAccountSnapshot({
      account: params.account,
      cfg: params.cfg,
      runtime: params.runtime,
      probe: params.probe,
      audit: params.audit,
    });
  } else {
    snapshot = {
      accountId: params.accountId,
      ...projectSafeChannelAccountSnapshotFields(params.account),
      ...projectSafeChannelAccountSnapshotFields(params.runtime),
    };
  }

  params.assertActive?.();

  const described = await describeChannelAccount(params);
  params.assertActive?.();
  const enabled = params.plugin.config.isEnabled
    ? params.plugin.config.isEnabled(params.account, params.cfg)
    : (described?.enabled ?? snapshot.enabled ?? params.enabledFallback ?? true);
  params.assertActive?.();
  const configured =
    described?.configured ??
    (params.plugin.config.isConfigured
      ? await params.plugin.config.isConfigured(params.account, params.cfg)
      : (snapshot.configured ?? params.configuredFallback ?? true));
  params.assertActive?.();
  const linkState =
    configured && params.plugin.config.isLinked
      ? await params.plugin.config.isLinked(params.account, params.cfg)
      : undefined;
  params.assertActive?.();
  const state = resolveChannelAccountState({
    enabled,
    configured,
    linked: resolveChannelAccountLinked(linkState, described?.linked ?? snapshot.linked),
    runtime: snapshot,
    disabledReason: params.plugin.config.disabledReason?.(params.account, params.cfg),
    unconfiguredReason: params.plugin.config.unconfiguredReason?.(params.account, params.cfg),
    unlinkedReason: params.plugin.config.unlinkedReason?.(params.account, params.cfg),
  });
  const projectedSnapshot = { ...snapshot };
  applyChannelAccountState(projectedSnapshot, state);
  return redactChannelStatusSummaryBaseUrl({
    ...projectedSnapshot,
    enabled,
    accountId: normalizeOptionalString(snapshot.accountId) ? snapshot.accountId : params.accountId,
    ...(params.probe !== undefined && snapshot.probe === undefined ? { probe: params.probe } : {}),
  });
}

export async function buildReadOnlySourceChannelAccountSnapshot<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount, unknown, unknown, 1 | 2>;
  cfg: OpenClawConfig;
  accountId: string;
  runtime?: ChannelAccountSnapshot;
  probe?: unknown;
  audit?: unknown;
}): Promise<ChannelAccountSnapshot | null> {
  const inspectedAccount = await inspectChannelAccount(params);
  if (!inspectedAccount) {
    return null;
  }
  return buildChannelAccountSnapshotFromInspection({
    ...params,
    account: inspectedAccount,
  });
}

export async function resolveChannelAccountSnapshot<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount, unknown, unknown, 1 | 2>;
  cfg: OpenClawConfig;
  accountId: string;
  runtime?: ChannelAccountSnapshot;
  probe?: unknown;
  audit?: unknown;
}): Promise<ChannelAccountSnapshot> {
  const unavailable = resolveUnavailableChannelAccountSnapshot(params.cfg, {
    channelId: params.plugin.id,
    accountId: params.accountId,
    runtime: params.runtime,
  });
  if (unavailable) {
    return unavailable;
  }
  const inspected = await buildReadOnlySourceChannelAccountSnapshot(params);
  if (inspected) {
    return inspected;
  }
  return await buildChannelAccountSnapshotFromAccount({
    ...params,
    account: await resolveChannelAccount(params),
  });
}
