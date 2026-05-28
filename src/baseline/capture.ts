import fs from "node:fs";
import path from "node:path";
import { listAgentEntries } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { listConfiguredChannelIdsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";

/**
 * Baseline Capture and Compare
 *
 * Captures system state snapshots for regression detection.
 * Used after repairs, upgrades, or configuration changes.
 *
 * `openclaw baseline capture` - captures current state
 * `openclaw baseline compare` - compares current state to baseline
 */

export const BASELINE_DIRNAME = "baselines";
export const BASELINE_FILENAME = "baseline.json";

export type BaselineSeverity = "pass" | "warn" | "fail";

export type ComponentStatus = {
  status: BaselineSeverity;
  message?: string;
  details?: Record<string, unknown>;
};

export type BaselineCapture = {
  version: string;
  timestamp: string;
  openClawVersion: string;
  components: {
    gateway: ComponentStatus;
    channels: ComponentStatus;
    agents: ComponentStatus;
    tasks: ComponentStatus;
    locks: ComponentStatus;
    plugins: ComponentStatus;
  };
  metrics: {
    sessionCount: number;
    agentCount: number;
    channelCount: number;
    activeTaskCount: number;
    gatewayPid?: number;
    gatewayUptimeMs?: number;
  };
  config?: {
    agentBindings: number;
    configuredChannels: number;
    enabledPlugins: number;
  };
};

export type BaselineComparison = {
  baseline: BaselineCapture;
  current: BaselineCapture;
  diff: {
    components: {
      gateway?: { baseline: BaselineSeverity; current: BaselineSeverity };
      channels?: { baseline: BaselineSeverity; current: BaselineSeverity };
      agents?: { baseline: BaselineSeverity; current: BaselineSeverity };
      tasks?: { baseline: BaselineSeverity; current: BaselineSeverity };
      locks?: { baseline: BaselineSeverity; current: BaselineSeverity };
      plugins?: { baseline: BaselineSeverity; current: BaselineSeverity };
    };
    metrics: {
      sessionCount?: { baseline: number; current: number; delta: number };
      agentCount?: { baseline: number; current: number; delta: number };
      channelCount?: { baseline: number; current: number; delta: number };
      activeTaskCount?: { baseline: number; current: number; delta: number };
    };
  };
  overallStatus: BaselineSeverity;
  regressions: string[];
  improvements: string[];
};

function resolveBaselineDir(_config?: OpenClawConfig): string {
  const stateDir = resolveStateDir();
  const baselineDir = path.join(stateDir, BASELINE_DIRNAME);
  if (!fs.existsSync(baselineDir)) {
    fs.mkdirSync(baselineDir, { recursive: true });
  }
  return baselineDir;
}

function resolveBaselinePath(name: string, config?: OpenClawConfig): string {
  return path.join(resolveBaselineDir(config), `${name}.json`);
}

export async function captureBaseline(options?: {
  name?: string;
  config?: OpenClawConfig;
  skipGateway?: boolean;
  skipPlugins?: boolean;
  gatewayTimeoutMs?: number;
}): Promise<BaselineCapture> {
  const config = options?.config;
  const gatewayTimeoutMs = options?.gatewayTimeoutMs ?? 5000;
  const version = "1.0.0";

  const gateway: ComponentStatus = await checkGatewayStatus(options?.skipGateway, gatewayTimeoutMs);
  const channels: ComponentStatus = await checkChannelsStatus(config, gatewayTimeoutMs);
  const agents: ComponentStatus = await checkAgentsStatus();
  const tasks: ComponentStatus = await checkTasksStatus(gatewayTimeoutMs);
  const locks: ComponentStatus = await checkLocksStatus();
  const plugins: ComponentStatus = await checkPluginsStatus(options?.skipPlugins);

  const agentCount = listAgentEntries({}).length;
  const channelCount = listConfiguredChannelIdsForReadOnlyScope({ config: config ?? {} }).length;
  const pluginCount = loadPluginManifestRegistry({ config }).plugins.length;

  const sessionCount = await countSessions(gatewayTimeoutMs);
  let taskCount = 0;
  try {
    taskCount = await countActiveTasks(gatewayTimeoutMs);
  } catch {
    // task count unknown
  }

  const baseline: BaselineCapture = {
    version,
    timestamp: new Date().toISOString(),
    openClawVersion: process.env.npm_package_version ?? "unknown",
    components: {
      gateway,
      channels,
      agents,
      tasks,
      locks,
      plugins,
    },
    metrics: {
      sessionCount,
      agentCount,
      channelCount,
      activeTaskCount: taskCount,
      gatewayPid: gateway.details?.pid as number | undefined,
      gatewayUptimeMs: gateway.details?.uptimeMs as number | undefined,
    },
  };

  const configBindings = (config as { agents?: { default?: { bindings?: unknown } } })?.agents
    ?.default?.bindings;
  baseline.config = {
    agentBindings: Array.isArray(configBindings) ? configBindings.length : 0,
    configuredChannels: channelCount,
    enabledPlugins: pluginCount,
  };

  return baseline;
}

export async function saveBaseline(
  baseline: BaselineCapture,
  name: string,
  config?: OpenClawConfig,
): Promise<string> {
  const baselinePath = resolveBaselinePath(name, config);
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf-8");
  return baselinePath;
}

export function loadBaseline(name: string, config?: OpenClawConfig): BaselineCapture | null {
  const baselinePath = resolveBaselinePath(name, config);
  if (!fs.existsSync(baselinePath)) {
    return null;
  }
  const content = fs.readFileSync(baselinePath, "utf-8");
  try {
    return JSON.parse(content) as BaselineCapture;
  } catch {
    return null;
  }
}

export function listBaselines(config?: OpenClawConfig): string[] {
  const baselineDir = resolveBaselineDir(config);
  const files = fs.readdirSync(baselineDir).filter((f) => f.endsWith(".json"));
  return files.map((f) => path.basename(f, ".json"));
}

export async function compareBaseline(
  baselineName: string,
  options?: {
    config?: OpenClawConfig;
    skipGateway?: boolean;
    skipPlugins?: boolean;
    gatewayTimeoutMs?: number;
  },
): Promise<BaselineComparison> {
  const baseline = loadBaseline(baselineName, options?.config);
  if (!baseline) {
    throw new Error(`Baseline not found: ${baselineName}`);
  }

  const current = await captureBaseline(options);

  const regressions: string[] = [];
  const improvements: string[] = [];

  const componentDiff: BaselineComparison["diff"]["components"] = {};

  for (const key of Object.keys(baseline.components) as Array<keyof typeof baseline.components>) {
    const baselineStatus = baseline.components[key].status;
    const currentStatus = current.components[key].status;

    if (baselineStatus !== currentStatus) {
      componentDiff[key] = { baseline: baselineStatus, current: currentStatus };

      if (statusToScore(currentStatus) < statusToScore(baselineStatus)) {
        regressions.push(`${key}: ${baselineStatus} -> ${currentStatus}`);
      } else {
        improvements.push(`${key}: ${baselineStatus} -> ${currentStatus}`);
      }
    }
  }

  const metricsDiff: BaselineComparison["diff"]["metrics"] = {};

  if (baseline.metrics.sessionCount !== current.metrics.sessionCount) {
    metricsDiff.sessionCount = {
      baseline: baseline.metrics.sessionCount,
      current: current.metrics.sessionCount,
      delta: current.metrics.sessionCount - baseline.metrics.sessionCount,
    };
  }

  if (baseline.metrics.agentCount !== current.metrics.agentCount) {
    metricsDiff.agentCount = {
      baseline: baseline.metrics.agentCount,
      current: current.metrics.agentCount,
      delta: current.metrics.agentCount - baseline.metrics.agentCount,
    };
  }

  if (baseline.metrics.channelCount !== current.metrics.channelCount) {
    metricsDiff.channelCount = {
      baseline: baseline.metrics.channelCount,
      current: current.metrics.channelCount,
      delta: current.metrics.channelCount - baseline.metrics.channelCount,
    };
  }

  if (baseline.metrics.activeTaskCount !== current.metrics.activeTaskCount) {
    metricsDiff.activeTaskCount = {
      baseline: baseline.metrics.activeTaskCount,
      current: current.metrics.activeTaskCount,
      delta: current.metrics.activeTaskCount - baseline.metrics.activeTaskCount,
    };
  }

  let overallStatus: BaselineSeverity = "pass";
  if (regressions.length > 0) {
    overallStatus = "fail";
  } else if (improvements.length > 0) {
    overallStatus = "pass";
  }

  return {
    baseline,
    current,
    diff: {
      components: componentDiff,
      metrics: metricsDiff,
    },
    overallStatus,
    regressions,
    improvements,
  };
}

function statusToScore(status: BaselineSeverity): number {
  switch (status) {
    case "pass":
      return 2;
    case "warn":
      return 1;
    case "fail":
      return 0;
  }
  return 0;
}

async function checkGatewayStatus(skip?: boolean, timeoutMs = 5000): Promise<ComponentStatus> {
  if (skip) {
    return { status: "pass", message: "Skipped" };
  }

  try {
    const result = await callGateway({
      method: "status",
      params: {},
      timeoutMs,
    });

    return {
      status: "pass",
      message: "Gateway responded",
      details: {
        eventLoop: result.eventLoop,
        runtimeVersion: result.runtimeVersion,
      },
    };
  } catch (err) {
    return { status: "fail", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function countSessions(timeoutMs = 5000): Promise<number> {
  try {
    const result = await callGateway<{ sessions?: unknown[]; totalCount?: number }>({
      method: "sessions.list",
      params: { limit: 1 },
      timeoutMs,
    });
    if (typeof result?.totalCount === "number" && Number.isFinite(result.totalCount)) {
      return Math.max(0, Math.trunc(result.totalCount));
    }
    return Array.isArray(result?.sessions) ? result.sessions.length : 0;
  } catch {
    return 0;
  }
}

async function countActiveTasks(timeoutMs = 5000): Promise<number> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let count = 0;

  do {
    const result = await callGateway<{ tasks?: unknown[]; nextCursor?: string }>({
      method: "tasks.list",
      params: {
        status: ["queued", "running"],
        limit: 500,
        ...(cursor ? { cursor } : {}),
      },
      timeoutMs,
    });
    count += Array.isArray(result?.tasks) ? result.tasks.length : 0;

    const nextCursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return count;
}

type ChannelStatusSummary = {
  configured?: boolean;
  connected?: boolean;
  linked?: boolean;
};

type ChannelAccountStatusSummary = ChannelStatusSummary & {
  running?: boolean;
  accountId?: string;
};

function listChannelStatusSummaries(
  channels: Record<string, ChannelStatusSummary> | ChannelStatusSummary[] | undefined,
): ChannelStatusSummary[] {
  if (Array.isArray(channels)) {
    return channels;
  }
  if (channels && typeof channels === "object") {
    return Object.values(channels);
  }
  return [];
}

function listChannelAccountStatusSummaries(
  accounts: Record<string, ChannelAccountStatusSummary> | ChannelAccountStatusSummary[] | undefined,
): ChannelAccountStatusSummary[] {
  if (Array.isArray(accounts)) {
    return accounts;
  }
  if (accounts && typeof accounts === "object") {
    return Object.values(accounts);
  }
  return [];
}

function isChannelConnected(channel: ChannelStatusSummary): boolean {
  return channel.connected === true || channel.linked === true;
}

function isChannelAccountConnected(account: ChannelAccountStatusSummary): boolean {
  return account.connected === true || (account.running === true && account.connected !== false);
}

async function checkChannelsStatus(
  config?: OpenClawConfig,
  timeoutMs = 5000,
): Promise<ComponentStatus> {
  try {
    const channelIds = listConfiguredChannelIdsForReadOnlyScope({ config: config ?? {} });
    if (channelIds.length === 0) {
      return { status: "pass", message: "No channels configured" };
    }

    const result = await callGateway<{
      channels?: Record<string, ChannelStatusSummary> | ChannelStatusSummary[];
      channelAccounts?: Record<
        string,
        Record<string, ChannelAccountStatusSummary> | ChannelAccountStatusSummary[]
      >;
    }>({
      method: "channels.status",
      params: {},
      timeoutMs,
    });

    const channels = listChannelStatusSummaries(result?.channels);
    const connectedFromAccounts = channelIds.filter((channelId) =>
      listChannelAccountStatusSummaries(result?.channelAccounts?.[channelId]).some(
        isChannelAccountConnected,
      ),
    ).length;
    const connected =
      result?.channelAccounts && Object.keys(result.channelAccounts).length > 0
        ? connectedFromAccounts
        : channels.filter(isChannelConnected).length;
    const total = channelIds.length;

    if (connected === total) {
      return {
        status: "pass",
        message: `All ${total} channels connected`,
        details: { connected, total },
      };
    } else if (connected > 0) {
      return {
        status: "warn",
        message: `${connected}/${total} channels connected`,
        details: { connected, total },
      };
    }

    return {
      status: "fail",
      message: `0/${total} channels connected`,
      details: { connected, total },
    };
  } catch (err) {
    return { status: "warn", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function checkAgentsStatus(): Promise<ComponentStatus> {
  try {
    const entries = listAgentEntries({});
    return {
      status: "pass",
      message: `${entries.length} agents`,
      details: { count: entries.length },
    };
  } catch (err) {
    return { status: "warn", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function checkTasksStatus(timeoutMs = 5000): Promise<ComponentStatus> {
  try {
    const count = await countActiveTasks(timeoutMs);
    return { status: "pass", message: `${count} active tasks`, details: { count } };
  } catch (err) {
    return { status: "warn", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function checkLocksStatus(): Promise<ComponentStatus> {
  try {
    const stateDir = resolveStateDir();
    const locksDir = path.join(stateDir, "locks");
    if (!fs.existsSync(locksDir)) {
      return { status: "pass", message: "No locks directory" };
    }
    const lockFiles = fs.readdirSync(locksDir).filter((f) => f.endsWith(".lock"));
    if (lockFiles.length === 0) {
      return { status: "pass", message: "No locks" };
    }
    return {
      status: "warn",
      message: `${lockFiles.length} stale locks`,
      details: { files: lockFiles },
    };
  } catch (err) {
    return { status: "warn", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function checkPluginsStatus(skip?: boolean): Promise<ComponentStatus> {
  if (skip) {
    return { status: "pass", message: "Skipped" };
  }

  try {
    const count = loadPluginManifestRegistry().plugins.length;
    return { status: "pass", message: `${count} plugins loaded`, details: { count } };
  } catch (err) {
    return { status: "warn", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

export { resolveBaselineDir, resolveBaselinePath };
