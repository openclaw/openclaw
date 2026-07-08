// Hooks CLI for listing, checking, toggling, installing, and updating hook integrations.
import type { Command } from "commander";
import {
  decorativeEmoji,
  decorativePrefix,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { READ_SCOPE, WRITE_SCOPE } from "../gateway/operator-scopes.js";
import {
  buildWorkspaceHookStatus,
  type HookStatusEntry,
  type HookStatusReport,
} from "../hooks/hooks-status.js";
import { resolveHookEntries } from "../hooks/policy.js";
import type { HookEntry } from "../hooks/types.js";
import { loadWorkspaceHookEntries } from "../hooks/workspace.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildPluginDiagnosticsReport } from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";
import { runNativeHookRelayCli, type NativeHookRelayCliOptions } from "./native-hook-relay-cli.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";

export type HooksListOptions = {
  json?: boolean;
  eligible?: boolean;
  verbose?: boolean;
};

export type HookInfoOptions = {
  json?: boolean;
};

export type HooksCheckOptions = {
  json?: boolean;
};

export type HooksUpdateOptions = {
  all?: boolean;
  dryRun?: boolean;
};

type HookQueueStatus = "queued" | "running" | "ok" | "error";

type HookQueueSummary = {
  id: string;
  path: string;
  parallelism: number;
  sessionTarget: string;
  agentId?: string | null;
  paused?: boolean;
  pausedAtMs?: number | null;
  counts: Record<HookQueueStatus, number>;
  oldestQueuedAtMs?: number | null;
  newestQueuedAtMs?: number | null;
};

type HookQueuesResult = {
  queues?: HookQueueSummary[];
};

type HookQueueItem = {
  itemId: string;
  queueId: string;
  status: HookQueueStatus;
  runId: string;
  sourcePath: string;
  name: string;
  message: string;
  messagePreview: string;
  agentId?: string | null;
  sessionKey: string;
  sessionTarget: string;
  createdAtMs: number;
  updatedAtMs: number;
  error?: string | null;
  summary?: string | null;
};

type HookQueueItemsResult = {
  items?: HookQueueItem[];
  total?: number;
  limit?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
};

type HookQueueStateResult = {
  queueId: string;
  paused: boolean;
  pausedAtMs: number | null;
  updatedAtMs: number;
};

type HooksQueueListOptions = GatewayRpcOpts & {
  json?: boolean;
};

type HooksQueueItemsOptions = GatewayRpcOpts & {
  json?: boolean;
  status?: string;
  limit?: string;
  offset?: string;
};

type HooksQueueStateOptions = GatewayRpcOpts & {
  json?: boolean;
};

function mergeHookEntries(pluginEntries: HookEntry[], workspaceEntries: HookEntry[]): HookEntry[] {
  return resolveHookEntries([...pluginEntries, ...workspaceEntries]);
}

function buildHooksReport(config: OpenClawConfig): HookStatusReport {
  // Plugin-managed and workspace hooks share one resolved policy view for status/actions.
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const workspaceEntries = loadWorkspaceHookEntries(workspaceDir, { config });
  const pluginReport = buildPluginDiagnosticsReport({ config, workspaceDir });
  const pluginEntries = pluginReport.hooks.map((hook) => hook.entry);
  const entries = mergeHookEntries(pluginEntries, workspaceEntries);
  return buildWorkspaceHookStatus(workspaceDir, { config, entries });
}

function resolveHookForToggle(
  report: HookStatusReport,
  hookName: string,
  opts?: { requireEligible?: boolean },
): HookStatusEntry {
  const hook = report.hooks.find((h) => h.name === hookName);
  if (!hook) {
    throw new Error(`Hook "${hookName}" not found`);
  }
  if (hook.managedByPlugin) {
    throw new Error(
      `Hook "${hookName}" is managed by plugin "${hook.pluginId ?? "unknown"}" and cannot be enabled/disabled.`,
    );
  }
  if (opts?.requireEligible && !hook.requirementsSatisfied) {
    throw new Error(`Hook "${hookName}" is not eligible (missing requirements)`);
  }
  return hook;
}

function buildConfigWithHookEnabled(params: {
  config: OpenClawConfig;
  hookName: string;
  enabled: boolean;
  ensureHooksEnabled?: boolean;
}): OpenClawConfig {
  const entries = { ...params.config.hooks?.internal?.entries };
  entries[params.hookName] = { ...entries[params.hookName], enabled: params.enabled };

  const internal = {
    ...params.config.hooks?.internal,
    ...(params.ensureHooksEnabled ? { enabled: true } : {}),
    entries,
  };

  return {
    ...params.config,
    hooks: {
      ...params.config.hooks,
      internal,
    },
  };
}

function formatHookStatus(hook: HookStatusEntry): string {
  if (hook.loadable) {
    return theme.success("✓ ready");
  }
  if (!hook.enabledByConfig) {
    return theme.warn(decorativePrefix("⏸", "disabled"));
  }
  return theme.error("✗ missing");
}

function formatHookName(hook: HookStatusEntry): string {
  const emoji = hook.emoji ?? decorativeEmoji("🔗");
  const name = theme.command(hook.name);
  return emoji ? `${emoji} ${name}` : name;
}

function formatHookSource(hook: HookStatusEntry): string {
  if (!hook.managedByPlugin) {
    return hook.source;
  }
  return `plugin:${hook.pluginId ?? "unknown"}`;
}

function formatHookMissingSummary(hook: HookStatusEntry): string {
  const missing: string[] = [];
  if (hook.missing.bins.length > 0) {
    missing.push(`bins: ${hook.missing.bins.join(", ")}`);
  }
  if (hook.missing.anyBins.length > 0) {
    missing.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
  }
  if (hook.missing.env.length > 0) {
    missing.push(`env: ${hook.missing.env.join(", ")}`);
  }
  if (hook.missing.config.length > 0) {
    missing.push(`config: ${hook.missing.config.join(", ")}`);
  }
  if (hook.missing.os.length > 0) {
    missing.push(`os: ${hook.missing.os.join(", ")}`);
  }
  return missing.join("; ");
}

function exitHooksCliWithError(err: unknown): never {
  defaultRuntime.error(`${theme.error("Error:")} ${formatErrorMessage(err)}`);
  process.exit(1);
}

function writeHooksOutput(value: string, json: boolean | undefined): void {
  if (json) {
    defaultRuntime.writeStdout(value);
    return;
  }
  defaultRuntime.log(value);
}

function formatOptionalTimestamp(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function hookQueueCount(queue: HookQueueSummary, status: HookQueueStatus): number {
  return Number(queue.counts?.[status] ?? 0);
}

function hookQueueTotal(queue: HookQueueSummary): number {
  return (["queued", "running", "ok", "error"] as const).reduce(
    (sum, status) => sum + hookQueueCount(queue, status),
    0,
  );
}

function normalizeHookQueueStatuses(raw: string | undefined): HookQueueStatus[] | undefined {
  if (!raw) {
    return undefined;
  }
  const statuses = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(
      (entry): entry is HookQueueStatus =>
        entry === "queued" || entry === "running" || entry === "ok" || entry === "error",
    );
  return statuses.length > 0 ? statuses : undefined;
}

function parseNonNegativeCliInteger(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

export function formatHookQueuesList(
  result: HookQueuesResult,
  opts: HooksQueueListOptions,
): string {
  const queues = Array.isArray(result.queues) ? result.queues : [];
  if (opts.json) {
    return JSON.stringify({ queues }, null, 2);
  }
  if (queues.length === 0) {
    return "No hook queues configured.";
  }
  const rows = queues.map((queue) => ({
    State: queue.paused ? theme.warn(decorativePrefix("⏸", "paused")) : theme.success("running"),
    Queue: theme.command(queue.id),
    Depth: String(hookQueueCount(queue, "queued")),
    Running: String(hookQueueCount(queue, "running")),
    Total: String(hookQueueTotal(queue)),
    Done: String(hookQueueCount(queue, "ok")),
    Errors: hookQueueCount(queue, "error")
      ? theme.error(String(hookQueueCount(queue, "error")))
      : "0",
    Parallel: String(queue.parallelism),
    Session: queue.sessionTarget,
    Path: queue.path,
  }));
  return [
    `${theme.heading("Hook Queues")} ${theme.muted(`(${queues.length})`)}`,
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "State", header: "State", minWidth: 9 },
        { key: "Queue", header: "Queue", minWidth: 14, flex: true },
        { key: "Depth", header: "Depth", minWidth: 5 },
        { key: "Running", header: "Running", minWidth: 7 },
        { key: "Total", header: "Total", minWidth: 5 },
        { key: "Done", header: "Done", minWidth: 5 },
        { key: "Errors", header: "Errors", minWidth: 6 },
        { key: "Parallel", header: "Parallel", minWidth: 8 },
        { key: "Session", header: "Session", minWidth: 10, flex: true },
        { key: "Path", header: "Path", minWidth: 16, flex: true },
      ],
      rows,
    }).trimEnd(),
  ].join("\n");
}

export function formatHookQueueItems(
  queueId: string,
  result: HookQueueItemsResult,
  opts: HooksQueueItemsOptions,
): string {
  const items = Array.isArray(result.items) ? result.items : [];
  if (opts.json) {
    return JSON.stringify({ ...result, items }, null, 2);
  }
  if (items.length === 0) {
    return `No hook queue items found for ${theme.command(queueId)}.`;
  }
  const total = Number(result.total ?? items.length);
  const rows = items.map((item) => ({
    Status: item.status === "error" ? theme.error(item.status) : item.status,
    Item: theme.command(item.itemId),
    Name: item.name,
    Message: item.messagePreview,
    Created: formatOptionalTimestamp(item.createdAtMs),
    Updated: formatOptionalTimestamp(item.updatedAtMs),
    Error: item.error ?? "",
  }));
  return [
    `${theme.heading("Hook Queue Items")} ${theme.muted(`${queueId}: ${items.length}/${total}`)}`,
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Status", header: "Status", minWidth: 8 },
        { key: "Item", header: "Item", minWidth: 12, flex: true },
        { key: "Name", header: "Name", minWidth: 12, flex: true },
        { key: "Message", header: "Message", minWidth: 20, flex: true },
        { key: "Created", header: "Created", minWidth: 20 },
        { key: "Updated", header: "Updated", minWidth: 20 },
        { key: "Error", header: "Error", minWidth: 12, flex: true },
      ],
      rows,
    }).trimEnd(),
  ].join("\n");
}

export function formatHookQueueState(result: HookQueueStateResult, opts: HooksQueueStateOptions) {
  if (opts.json) {
    return JSON.stringify(result, null, 2);
  }
  const state = result.paused ? theme.warn("paused") : theme.success("running");
  return `Hook queue ${theme.command(result.queueId)} is ${state}.`;
}

async function runHooksCliAction(action: () => Promise<void> | void): Promise<void> {
  try {
    await action();
  } catch (err) {
    exitHooksCliWithError(err);
  }
}

/**
 * Format the hooks list output
 */
export function formatHooksList(report: HookStatusReport, opts: HooksListOptions): string {
  const hooks = opts.eligible ? report.hooks.filter((h) => h.loadable) : report.hooks;

  if (opts.json) {
    const jsonReport = {
      workspaceDir: report.workspaceDir,
      managedHooksDir: report.managedHooksDir,
      hooks: hooks.map((h) => ({
        name: h.name,
        description: h.description,
        emoji: h.emoji,
        eligible: h.loadable,
        disabled: !h.enabledByConfig,
        enabledByConfig: h.enabledByConfig,
        requirementsSatisfied: h.requirementsSatisfied,
        loadable: h.loadable,
        blockedReason: h.blockedReason,
        source: h.source,
        pluginId: h.pluginId,
        events: h.events,
        unknownEvents: h.unknownEvents,
        homepage: h.homepage,
        missing: h.missing,
        managedByPlugin: h.managedByPlugin,
      })),
    };
    return JSON.stringify(jsonReport, null, 2);
  }

  if (hooks.length === 0) {
    const message = opts.eligible
      ? `No eligible hooks found. Run \`${formatCliCommand("openclaw hooks list")}\` to see all hooks.`
      : "No hooks found.";
    return message;
  }

  const eligible = hooks.filter((h) => h.loadable);
  const tableWidth = getTerminalTableWidth();
  const rows = hooks.map((hook) => {
    const missing = formatHookMissingSummary(hook);
    return {
      Status: formatHookStatus(hook),
      Hook: formatHookName(hook),
      Description: theme.muted(hook.description),
      Source: formatHookSource(hook),
      Missing: missing ? theme.warn(missing) : "",
    };
  });

  const columns = [
    { key: "Status", header: "Status", minWidth: 10 },
    { key: "Hook", header: "Hook", minWidth: 18, flex: true },
    { key: "Description", header: "Description", minWidth: 24, flex: true },
    { key: "Source", header: "Source", minWidth: 12, flex: true },
  ];
  if (opts.verbose) {
    columns.push({ key: "Missing", header: "Missing", minWidth: 18, flex: true });
  }

  const lines: string[] = [];
  lines.push(
    `${theme.heading("Hooks")} ${theme.muted(`(${eligible.length}/${hooks.length} ready)`)}`,
  );
  lines.push(
    renderTable({
      width: tableWidth,
      columns,
      rows,
    }).trimEnd(),
  );
  return lines.join("\n");
}

/**
 * Format detailed info for a single hook
 */
export function formatHookInfo(
  report: HookStatusReport,
  hookName: string,
  opts: HookInfoOptions,
): string {
  const hook = report.hooks.find((h) => h.name === hookName || h.hookKey === hookName);

  if (!hook) {
    if (opts.json) {
      return JSON.stringify({ error: "not found", hook: hookName }, null, 2);
    }
    return `Hook "${hookName}" not found. Run \`${formatCliCommand("openclaw hooks list")}\` to see available hooks.`;
  }

  if (opts.json) {
    return JSON.stringify(
      {
        ...hook,
        eligible: hook.loadable,
        disabled: !hook.enabledByConfig,
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  const emoji = hook.emoji ?? decorativeEmoji("🔗");
  const status = hook.loadable
    ? theme.success("✓ Ready")
    : !hook.enabledByConfig
      ? theme.warn(decorativePrefix("⏸", "Disabled"))
      : theme.error("✗ Missing requirements");

  lines.push(`${emoji ? `${emoji} ` : ""}${theme.heading(hook.name)} ${status}`);
  lines.push("");
  lines.push(hook.description);
  lines.push("");

  // Details
  lines.push(theme.heading("Details:"));
  if (hook.managedByPlugin) {
    lines.push(`${theme.muted("  Source:")} ${hook.source} (${hook.pluginId ?? "unknown"})`);
  } else {
    lines.push(`${theme.muted("  Source:")} ${hook.source}`);
  }
  lines.push(`${theme.muted("  Path:")} ${shortenHomePath(hook.filePath)}`);
  lines.push(`${theme.muted("  Handler:")} ${shortenHomePath(hook.handlerPath)}`);
  if (hook.homepage) {
    lines.push(`${theme.muted("  Homepage:")} ${hook.homepage}`);
  }
  if (hook.events.length > 0) {
    lines.push(`${theme.muted("  Events:")} ${hook.events.join(", ")}`);
  }
  if (hook.unknownEvents.length > 0) {
    lines.push(
      theme.warn(
        `  ⚠ Event${hook.unknownEvents.length === 1 ? "" : "s"} not emitted by core (likely typo): ${hook.unknownEvents.join(", ")}`,
      ),
    );
  }
  if (hook.managedByPlugin) {
    lines.push(theme.muted("  Managed by plugin; enable/disable via hooks CLI not available."));
  }
  if (hook.blockedReason) {
    lines.push(`${theme.muted("  Blocked reason:")} ${hook.blockedReason}`);
  }

  // Requirements
  const hasRequirements =
    hook.requirements.bins.length > 0 ||
    hook.requirements.anyBins.length > 0 ||
    hook.requirements.env.length > 0 ||
    hook.requirements.config.length > 0 ||
    hook.requirements.os.length > 0;

  if (hasRequirements) {
    lines.push("");
    lines.push(theme.heading("Requirements:"));
    if (hook.requirements.bins.length > 0) {
      const binsStatus = hook.requirements.bins.map((bin) => {
        const missing = hook.missing.bins.includes(bin);
        return missing ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
      });
      lines.push(`${theme.muted("  Binaries:")} ${binsStatus.join(", ")}`);
    }
    if (hook.requirements.anyBins.length > 0) {
      const anyBinsStatus =
        hook.missing.anyBins.length > 0
          ? theme.error(`✗ (any of: ${hook.requirements.anyBins.join(", ")})`)
          : theme.success(`✓ (any of: ${hook.requirements.anyBins.join(", ")})`);
      lines.push(`${theme.muted("  Any binary:")} ${anyBinsStatus}`);
    }
    if (hook.requirements.env.length > 0) {
      const envStatus = hook.requirements.env.map((env) => {
        const missing = hook.missing.env.includes(env);
        return missing ? theme.error(`✗ ${env}`) : theme.success(`✓ ${env}`);
      });
      lines.push(`${theme.muted("  Environment:")} ${envStatus.join(", ")}`);
    }
    if (hook.requirements.config.length > 0) {
      const configStatus = hook.configChecks.map((check) => {
        return check.satisfied ? theme.success(`✓ ${check.path}`) : theme.error(`✗ ${check.path}`);
      });
      lines.push(`${theme.muted("  Config:")} ${configStatus.join(", ")}`);
    }
    if (hook.requirements.os.length > 0) {
      const osStatus =
        hook.missing.os.length > 0
          ? theme.error(`✗ (${hook.requirements.os.join(", ")})`)
          : theme.success(`✓ (${hook.requirements.os.join(", ")})`);
      lines.push(`${theme.muted("  OS:")} ${osStatus}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format check output
 */
export function formatHooksCheck(report: HookStatusReport, opts: HooksCheckOptions): string {
  if (opts.json) {
    const eligible = report.hooks.filter((h) => h.loadable);
    const notEligible = report.hooks.filter((h) => !h.loadable);
    return JSON.stringify(
      {
        total: report.hooks.length,
        eligible: eligible.length,
        notEligible: notEligible.length,
        hooks: {
          eligible: eligible.map((h) => h.name),
          notEligible: notEligible.map((h) => ({
            name: h.name,
            blockedReason: h.blockedReason,
            missing: h.missing,
          })),
        },
      },
      null,
      2,
    );
  }

  const eligible = report.hooks.filter((h) => h.loadable);
  const notEligible = report.hooks.filter((h) => !h.loadable);

  const lines: string[] = [];
  lines.push(theme.heading("Hooks Status"));
  lines.push("");
  lines.push(`${theme.muted("Total hooks:")} ${report.hooks.length}`);
  lines.push(`${theme.success("Ready:")} ${eligible.length}`);
  lines.push(`${theme.warn("Not ready:")} ${notEligible.length}`);

  if (notEligible.length > 0) {
    lines.push("");
    lines.push(theme.heading("Hooks not ready:"));
    for (const hook of notEligible) {
      const reasons = [];
      if (hook.blockedReason && hook.blockedReason !== "missing requirements") {
        reasons.push(hook.blockedReason);
      }
      if (hook.missing.bins.length > 0) {
        reasons.push(`bins: ${hook.missing.bins.join(", ")}`);
      }
      if (hook.missing.anyBins.length > 0) {
        reasons.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
      }
      if (hook.missing.env.length > 0) {
        reasons.push(`env: ${hook.missing.env.join(", ")}`);
      }
      if (hook.missing.config.length > 0) {
        reasons.push(`config: ${hook.missing.config.join(", ")}`);
      }
      if (hook.missing.os.length > 0) {
        reasons.push(`os: ${hook.missing.os.join(", ")}`);
      }
      const emoji = hook.emoji ?? decorativeEmoji("🔗");
      lines.push(`  ${emoji ? `${emoji} ` : ""}${hook.name} - ${reasons.join("; ")}`);
    }
  }

  return lines.join("\n");
}

export async function enableHook(hookName: string): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  const config = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const hook = resolveHookForToggle(buildHooksReport(config), hookName, { requireEligible: true });
  const nextConfig = buildConfigWithHookEnabled({
    config,
    hookName,
    enabled: true,
    ensureHooksEnabled: true,
  });

  await replaceConfigFile({
    nextConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
  });
  defaultRuntime.log(
    `${theme.success("✓")} Enabled hook: ${hook.emoji ? `${hook.emoji} ${theme.command(hookName)}` : decorativePrefix("🔗", theme.command(hookName))}`,
  );
}

export async function disableHook(hookName: string): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  const config = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const hook = resolveHookForToggle(buildHooksReport(config), hookName);
  const nextConfig = buildConfigWithHookEnabled({ config, hookName, enabled: false });

  await replaceConfigFile({
    nextConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
  });
  defaultRuntime.log(
    `${theme.warn(decorativePrefix("⏸", "Disabled hook:"))} ${hook.emoji ? `${hook.emoji} ${theme.command(hookName)}` : decorativePrefix("🔗", theme.command(hookName))}`,
  );
}

export function registerHooksCli(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Manage internal agent hooks")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/hooks", "docs.openclaw.ai/cli/hooks")}\n`,
    );

  hooks
    .command("list")
    .description("List all hooks")
    .option("--eligible", "Show only eligible hooks", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) =>
      runHooksCliAction(async () => {
        const config = getRuntimeConfig();
        const report = buildHooksReport(config);
        writeHooksOutput(formatHooksList(report, opts), opts.json);
      }),
    );

  hooks
    .command("info <name>")
    .description("Show detailed information about a hook")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) =>
      runHooksCliAction(async () => {
        const config = getRuntimeConfig();
        const report = buildHooksReport(config);
        writeHooksOutput(formatHookInfo(report, name, opts), opts.json);
      }),
    );

  hooks
    .command("check")
    .description("Check hooks eligibility status")
    .option("--json", "Output as JSON", false)
    .action(async (opts) =>
      runHooksCliAction(async () => {
        const config = getRuntimeConfig();
        const report = buildHooksReport(config);
        writeHooksOutput(formatHooksCheck(report, opts), opts.json);
      }),
    );

  hooks
    .command("enable <name>")
    .description("Enable a hook")
    .action(async (name) =>
      runHooksCliAction(async () => {
        await enableHook(name);
      }),
    );

  hooks
    .command("disable <name>")
    .description("Disable a hook")
    .action(async (name) =>
      runHooksCliAction(async () => {
        await disableHook(name);
      }),
    );

  const queue = hooks.command("queue").description("Manage webhook queues");

  addGatewayClientOptions(
    queue
      .command("list")
      .description("List configured webhook queues")
      .option("--json", "Output as JSON", false),
  ).action(async (opts: HooksQueueListOptions) =>
    runHooksCliAction(async () => {
      const result = (await callGatewayFromCli(
        "hooks.queues",
        opts,
        {},
        {
          scopes: [READ_SCOPE],
        },
      )) as HookQueuesResult;
      writeHooksOutput(formatHookQueuesList(result, opts), opts.json);
    }),
  );

  addGatewayClientOptions(
    queue
      .command("items <queueId>")
      .description("Inspect webhook queue items")
      .option("--status <status>", "Filter statuses: queued,running,ok,error")
      .option("--limit <n>", "Maximum items to load", "50")
      .option("--offset <n>", "Pagination offset", "0")
      .option("--json", "Output as JSON", false),
  ).action(async (queueId: string, opts: HooksQueueItemsOptions) =>
    runHooksCliAction(async () => {
      const statuses = normalizeHookQueueStatuses(opts.status);
      const result = (await callGatewayFromCli(
        "hooks.queue.items",
        opts,
        {
          queueId,
          ...(statuses ? { statuses } : {}),
          limit: parseNonNegativeCliInteger(opts.limit, "limit"),
          offset: parseNonNegativeCliInteger(opts.offset, "offset"),
        },
        { scopes: [READ_SCOPE] },
      )) as HookQueueItemsResult;
      writeHooksOutput(formatHookQueueItems(queueId, result, opts), opts.json);
    }),
  );

  addGatewayClientOptions(
    queue
      .command("pause <queueId>")
      .description("Pause webhook queue processing")
      .option("--json", "Output as JSON", false),
  ).action(async (queueId: string, opts: HooksQueueStateOptions) =>
    runHooksCliAction(async () => {
      const result = (await callGatewayFromCli(
        "hooks.queue.pause",
        opts,
        { queueId },
        { scopes: [WRITE_SCOPE] },
      )) as HookQueueStateResult;
      writeHooksOutput(formatHookQueueState(result, opts), opts.json);
    }),
  );

  addGatewayClientOptions(
    queue
      .command("resume <queueId>")
      .description("Resume webhook queue processing")
      .option("--json", "Output as JSON", false),
  ).action(async (queueId: string, opts: HooksQueueStateOptions) =>
    runHooksCliAction(async () => {
      const result = (await callGatewayFromCli(
        "hooks.queue.resume",
        opts,
        { queueId },
        { scopes: [WRITE_SCOPE] },
      )) as HookQueueStateResult;
      writeHooksOutput(formatHookQueueState(result, opts), opts.json);
    }),
  );

  queue.action(async () =>
    runHooksCliAction(async () => {
      const result = (await callGatewayFromCli(
        "hooks.queues",
        {},
        {},
        {
          scopes: [READ_SCOPE],
        },
      )) as HookQueuesResult;
      defaultRuntime.log(formatHookQueuesList(result, {}));
    }),
  );

  hooks
    .command("relay", { hidden: true })
    .description("Internal native harness hook relay")
    .requiredOption("--provider <provider>", "Native harness provider")
    .requiredOption("--relay-id <id>", "Native hook relay id")
    .option("--generation <generation>", "Native hook relay registration generation")
    .requiredOption("--event <event>", "Native hook event")
    .option(
      "--pre-tool-use-unavailable <mode>",
      "PreToolUse fallback mode when the originating relay is unavailable",
    )
    .option("--timeout <ms>", "Gateway timeout in ms", "5000")
    .action(async (opts: NativeHookRelayCliOptions) =>
      runHooksCliAction(async () => {
        process.exitCode = await runNativeHookRelayCli(opts);
      }),
    );

  hooks
    .command("install")
    .description("Deprecated: install a hook pack via `openclaw plugins install`")
    .argument("<path-or-spec>", "Path to a hook pack or npm package spec")
    .option("-l, --link", "Link a local path instead of copying", false)
    .option("--pin", "Record npm installs as exact resolved <name>@<version>", false)
    .action(async (raw: string, opts: { link?: boolean; pin?: boolean }) => {
      defaultRuntime.log(
        theme.warn("`openclaw hooks install` is deprecated; use `openclaw plugins install`."),
      );
      await runPluginInstallCommand({ raw, opts, invalidateRuntimeCache: false });
    });

  hooks
    .command("update")
    .description("Deprecated: update hook packs via `openclaw plugins update`")
    .argument("[id]", "Hook pack id (omit with --all)")
    .option("--all", "Update all tracked hooks", false)
    .option("--dry-run", "Show what would change without writing", false)
    .action(async (id: string | undefined, opts: HooksUpdateOptions) => {
      defaultRuntime.log(
        theme.warn("`openclaw hooks update` is deprecated; use `openclaw plugins update`."),
      );
      await runPluginUpdateCommand({ id, opts });
    });

  hooks.action(async () =>
    runHooksCliAction(async () => {
      const config = getRuntimeConfig();
      const report = buildHooksReport(config);
      defaultRuntime.log(formatHooksList(report, {}));
    }),
  );
}
