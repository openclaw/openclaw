import { vi } from "vitest";
import type { getCredentialUnavailableDiagnostics } from "../channels/account-snapshot-fields.js";
import type { ChannelGatewayAdapterV2 } from "../channels/plugins/types.adapters.js";
import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { requireActivePluginChannelRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { evaluateChannelHealth } from "./channel-health-policy.js";
import { createChannelManager } from "./server-channels.js";

type TestPlugin = ChannelPlugin<TestAccount, unknown, unknown, 1 | 2>;

export type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
  credentialDiagnostics?: ReturnType<typeof getCredentialUnavailableDiagnostics>;
};

export function createTestNativeApprovalRuntime(): GatewayNativeApprovalRuntime {
  return {
    getRuntimeConfig: () => ({}),
    request: vi.fn(),
    requestRoute: vi.fn(),
    routeCoordinator: {} as never,
    subscribe: vi.fn(),
  };
}

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
  if (params?.includeDescribeAccount !== false) {
    config.describeAccount =
      params?.describeAccount ??
      ((resolved) => ({
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: resolved.enabled !== false,
        configured: resolved.configured !== false,
      }));
  }
  return {
    id,
    meta: {
      ...createChannelTestPluginBase({ id }).meta,
      blurb: "test stub",
      ...(params?.order === undefined ? {} : { order: params.order }),
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway: {
      apiVersion: 2,
      ...(params?.startAccount ? { startAccount: params.startAccount } : {}),
      ...(params?.stopAccount ? { stopAccount: params.stopAccount } : {}),
    },
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

export async function waitForMicrotaskCondition(
  check: () => boolean,
  message: string,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(message);
}

export function createTestChannelRegistry(
  ...plugins: Array<
    | TestPlugin
    | {
        plugin: TestPlugin;
        origin: string;
        resolveChannelRuntime?: () => PluginRuntime["channel"];
      }
  >
) {
  const registry = createEmptyPluginRegistry();
  for (const candidate of plugins) {
    const entry = "plugin" in candidate ? candidate : { plugin: candidate };
    registry.channels.push({
      pluginId: entry.plugin.id,
      source: "test",
      ...entry,
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
  return createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => ({}),
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: Object.fromEntries(channelIds.map((id) => [id, log.child(id)])),
    channelRuntimeEnvs: Object.fromEntries(channelIds.map((id) => [id, runtimeForLogger(log)])),
    ...overrides,
  });
}
