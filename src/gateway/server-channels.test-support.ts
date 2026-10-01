import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { evaluateChannelHealth } from "./channel-health-policy.js";

export type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
  credentialDiagnostics?: Array<{
    code: "CREDENTIAL_FILE_UNAVAILABLE";
    path: string;
    reason: string;
  }>;
};

export function healthOf(account: ChannelAccountSnapshot | undefined) {
  return evaluateChannelHealth(account ?? {}, {
    channelId: "discord",
    now: Date.now() + 60 * 60_000,
    channelConnectGraceMs: 120_000,
    staleEventThresholdMs: 30 * 60_000,
  });
}

export function createTestPlugin(params?: {
  id?: ChannelId;
  order?: number;
  account?: TestAccount;
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  stopAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["stopAccount"];
  listAccountIds?: ChannelPlugin<TestAccount>["config"]["listAccountIds"];
  includeDescribeAccount?: boolean;
  describeAccount?: ChannelPlugin<TestAccount>["config"]["describeAccount"];
  resolveAccount?: ChannelPlugin<TestAccount>["config"]["resolveAccount"];
  isConfigured?: ChannelPlugin<TestAccount>["config"]["isConfigured"];
  isLinked?: ChannelPlugin<TestAccount>["config"]["isLinked"];
  disabledReason?: ChannelPlugin<TestAccount>["config"]["disabledReason"];
  unconfiguredReason?: ChannelPlugin<TestAccount>["config"]["unconfiguredReason"];
  unlinkedReason?: ChannelPlugin<TestAccount>["config"]["unlinkedReason"];
}): ChannelPlugin<TestAccount> {
  const id = params?.id ?? "discord";
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: params?.listAccountIds ?? (() => [DEFAULT_ACCOUNT_ID]),
    resolveAccount: params?.resolveAccount ?? (() => account),
    isEnabled: (resolved) => resolved.enabled !== false,
    ...(params?.isConfigured ? { isConfigured: params.isConfigured } : {}),
    ...(params?.isLinked ? { isLinked: params.isLinked } : {}),
    ...(params?.disabledReason ? { disabledReason: params.disabledReason } : {}),
    ...(params?.unconfiguredReason ? { unconfiguredReason: params.unconfiguredReason } : {}),
    ...(params?.unlinkedReason ? { unlinkedReason: params.unlinkedReason } : {}),
  };
  if (includeDescribeAccount) {
    config.describeAccount =
      params?.describeAccount ??
      ((resolved) => ({
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: resolved.enabled !== false,
        configured: resolved.configured !== false,
      }));
  }
  const gateway: NonNullable<ChannelPlugin<TestAccount>["gateway"]> = {};
  if (params?.startAccount) {
    gateway.startAccount = params.startAccount;
  }
  if (params?.stopAccount) {
    gateway.stopAccount = params.stopAccount;
  }
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test stub",
      ...(params?.order === undefined ? {} : { order: params.order }),
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway,
  };
}
