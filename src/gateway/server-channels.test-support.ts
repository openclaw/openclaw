import type { ChannelGatewayAdapterV2 } from "../channels/plugins/types.adapters.js";
import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { requireActivePluginChannelRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { evaluateChannelHealth } from "./channel-health-policy.js";
import { createChannelManager } from "./server-channels.js";

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
  startAccount?: ChannelGatewayAdapterV2<TestAccount>["startAccount"];
  stopAccount?: ChannelGatewayAdapterV2<TestAccount>["stopAccount"];
  listAccountIds?: ChannelPlugin<TestAccount>["config"]["listAccountIds"];
  includeDescribeAccount?: boolean;
  describeAccount?: ChannelPlugin<TestAccount>["config"]["describeAccount"];
  resolveAccount?: ChannelPlugin<TestAccount>["config"]["resolveAccount"];
  isConfigured?: ChannelPlugin<TestAccount>["config"]["isConfigured"];
  isLinked?: ChannelPlugin<TestAccount>["config"]["isLinked"];
  disabledReason?: ChannelPlugin<TestAccount>["config"]["disabledReason"];
  unconfiguredReason?: ChannelPlugin<TestAccount>["config"]["unconfiguredReason"];
  unlinkedReason?: ChannelPlugin<TestAccount>["config"]["unlinkedReason"];
}): ChannelPlugin<TestAccount, unknown, unknown, 2> {
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
  const gateway: ChannelGatewayAdapterV2<TestAccount> = { apiVersion: 2 };
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

export function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

export function createTestChannelRegistry(
  ...plugins: Array<
    | ChannelPlugin<TestAccount, unknown, unknown, 1 | 2>
    | {
        plugin: ChannelPlugin<TestAccount, unknown, unknown, 1 | 2>;
        origin: string;
        resolveChannelRuntime?: () => PluginRuntime["channel"];
      }
  >
) {
  const registry = createEmptyPluginRegistry();
  for (const candidate of plugins) {
    const plugin = "plugin" in candidate ? candidate.plugin : candidate;
    registry.channels.push({
      pluginId: plugin.id,
      ...("origin" in candidate ? { origin: candidate.origin as never } : {}),
      ...(typeof candidate === "object" && "resolveChannelRuntime" in candidate
        ? { resolveChannelRuntime: candidate.resolveChannelRuntime }
        : {}),
      source: "test",
      plugin,
    } as PluginRegistry["channels"][number]);
  }
  return registry;
}

export function createTestChannelManager(
  options: Partial<
    Omit<Parameters<typeof createChannelManager>[0], "channelLogs" | "channelRuntimeEnvs">
  > & { channelIds?: ChannelId[] } = {},
) {
  const { channelIds = ["discord"], ...overrides } = options;
  const log = createSubsystemLogger("gateway/server-channels-test");
  const manager = createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => ({}),
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: Object.fromEntries(channelIds.map((id) => [id, log.child(id)])),
    channelRuntimeEnvs: Object.fromEntries(channelIds.map((id) => [id, runtimeForLogger(log)])),
    ...overrides,
  });
  return manager;
}
