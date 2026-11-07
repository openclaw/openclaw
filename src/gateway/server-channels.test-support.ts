import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { requireActivePluginChannelRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
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

export function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function installTestRegistry(
  ...plugins: Array<
    | ChannelPlugin<TestAccount>
    | {
        plugin: ChannelPlugin<TestAccount>;
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
  setActivePluginRegistry(registry);
  return registry;
}

export function createTestChannelManager(options?: {
  channelRuntime?: PluginRuntime["channel"];
  resolveChannelRuntime?: () => PluginRuntime["channel"] | Promise<PluginRuntime["channel"]>;
  getRuntimeConfig?: () => Record<string, unknown>;
  channelIds?: ChannelId[];
  startupTrace?: { measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T> };
  deferStartupAccountStartsUntil?: Promise<void>;
  ambientAutostartSuppressedChannelIds?: ReadonlySet<string>;
  tryRecoverAutostartSuppression?: () => boolean;
  isClosing?: () => boolean;
  getNativeApprovalRuntime?: () => GatewayNativeApprovalRuntime | undefined;
  getPluginRegistry?: () => PluginRegistry;
}) {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as unknown as Record<ChannelId, RuntimeEnv>;
  const channelIds = options?.channelIds ?? ["discord"];
  for (const channelId of channelIds) {
    channelLogs[channelId] ??= log.child(channelId);
    channelRuntimeEnvs[channelId] ??= runtime;
  }
  const manager = createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => options?.getRuntimeConfig?.() ?? {},
    getPluginRegistry: options?.getPluginRegistry ?? requireActivePluginChannelRegistry,
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
    ...(options?.resolveChannelRuntime
      ? { resolveChannelRuntime: options.resolveChannelRuntime }
      : {}),
    ...(options?.startupTrace ? { startupTrace: options.startupTrace } : {}),
    ...(options?.deferStartupAccountStartsUntil
      ? { deferStartupAccountStartsUntil: options.deferStartupAccountStartsUntil }
      : {}),
    ...(options?.ambientAutostartSuppressedChannelIds
      ? { ambientAutostartSuppressedChannelIds: options.ambientAutostartSuppressedChannelIds }
      : {}),
    ...(options?.tryRecoverAutostartSuppression
      ? { tryRecoverAutostartSuppression: options.tryRecoverAutostartSuppression }
      : {}),
    ...(options?.isClosing ? { isClosing: options.isClosing } : {}),
    ...(options?.getNativeApprovalRuntime
      ? { getNativeApprovalRuntime: options.getNativeApprovalRuntime }
      : {}),
  });
  return manager;
}
