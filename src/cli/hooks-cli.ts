import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  decorativeEmoji,
  decorativePrefix,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveAgentWorkspaceDir,
  resolveConfiguredAgentId,
  resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope.js";
import { captureRuntimeConfigAsyncReader, transformConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  parseHookFrontmatter,
  resolveHookKey,
  resolveHookManifestMetadata,
} from "../hooks/frontmatter.js";
import {
  buildWorkspaceHookStatus,
  type HookStatusEntry,
  type HookStatusReport,
} from "../hooks/hooks-status.js";
import { smokeLoadHookHandler } from "../hooks/loader.js";
import { resolveHookEntries } from "../hooks/policy.js";
import type { Hook, HookSource } from "../hooks/types.js";
import { loadWorkspaceHookEntries, prepareWorkspaceHookEntries } from "../hooks/workspace.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadGatewayStartupPluginPlanWithMetadata } from "../plugins/channel-plugin-ids.js";
import { withPluginDiagnosticsReport } from "../plugins/status.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { summarizeStringEntries } from "../shared/string-sample.js";
import { resolveConfigDir, shortenHomePath } from "../utils.js";
import { resolveOptionFromCommand } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import {
  ExpectedCliError,
  formatCliJsonFailure,
  rethrowExpectedCliError,
} from "./failure-output.js";
import { canFallbackToImplicitLocalGateway } from "./gateway-rpc.js";
import { formatDocsHelp } from "./help-format.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { runNativeHookRelayCli, type NativeHookRelayCliOptions } from "./native-hook-relay-cli.js";
import { requestExitAfterOneShotOutput } from "./one-shot-exit.js";
import type { RunPluginInstallCommandParams } from "./plugins-install-preflight.js";
import type { RunPluginUpdateCommandParams } from "./plugins-update-command.js";
import {
  formatCliRequirements,
  formatCliStatusTable,
  sanitizeCliDescriptorText,
} from "./skills-hooks-cli.format.js";

type HooksReportOptions = {
  agent?: string;
  json?: boolean;
};

type HooksListOptions = HooksReportOptions & {
  eligible?: boolean;
  verbose?: boolean;
};

function formatHookStatus(hook: HookStatusEntry, detailed = false): string {
  if (hook.loadable) {
    return theme.success(detailed ? "✓ Ready" : "✓ ready");
  }
  if (!hook.enabledByConfig) {
    return theme.warn(decorativePrefix("⏸", detailed ? "Disabled" : "disabled"));
  }
  const reason =
    hook.blockedReason && hook.blockedReason !== "missing requirements"
      ? sanitizeTerminalText(hook.blockedReason)
      : detailed
        ? "missing requirements"
        : "missing";
  return theme.error(
    `✗ ${detailed ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}` : reason}`,
  );
}

const HOOK_REQUIREMENT_GROUPS = [
  ["bins", "Binaries"],
  ["anyBins", "Any binary"],
  ["env", "Environment"],
  ["config", "Config"],
  ["os", "OS"],
] as const;

function formatHookMissingRequirements(hook: HookStatusEntry, itemLimit?: number): string[] {
  const formatEntries = (entries: string[]) =>
    itemLimit === undefined
      ? entries.join(", ")
      : summarizeStringEntries({ entries, limit: itemLimit });
  return HOOK_REQUIREMENT_GROUPS.filter(([key]) => hook.missing[key].length > 0).map(
    ([key]) => `${key}: ${formatEntries(hook.missing[key])}`,
  );
}

function formatHookMissingSummary(hook: HookStatusEntry, itemLimit?: number): string {
  const missing = formatHookMissingRequirements(hook, itemLimit);
  if (hook.enabledByConfig && hook.blockedReason && hook.blockedReason !== "missing requirements") {
    missing.unshift(hook.blockedReason);
  }
  return missing.join("; ");
}

function formatHooksList(report: HookStatusReport, opts: HooksListOptions): string {
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
    return opts.eligible
      ? `No eligible hooks found. Run \`${formatCliCommand("openclaw hooks list")}\` to see all hooks.`
      : "No hooks found.";
  }

  return formatCliStatusTable({
    title: "Hooks",
    ready: hooks.filter((hook) => hook.loadable).length,
    nameColumn: { key: "Hook", header: "Hook", minWidth: 18, flex: true },
    sourceColumn: { key: "Source", header: "Source", minWidth: 12, flex: true },
    verbose: opts.verbose,
    rows: hooks.map((hook) => {
      const emoji = sanitizeTerminalText(hook.emoji ?? decorativeEmoji("🔗"));
      const name = theme.command(sanitizeTerminalText(hook.name));
      return {
        Status: formatHookStatus(hook),
        Hook: emoji ? `${emoji} ${name}` : name,
        Description: theme.muted(sanitizeCliDescriptorText(hook.description)),
        Source: sanitizeTerminalText(
          hook.managedByPlugin ? `plugin:${hook.pluginId ?? "unknown"}` : hook.source,
        ),
        Missing: opts.verbose
          ? theme.warn(sanitizeTerminalText(formatHookMissingSummary(hook)))
          : "",
      };
    }),
  });
}

function formatHookInfo(
  hook: HookStatusEntry | undefined,
  hookName: string,
  opts: HooksReportOptions,
): string {
  if (!hook) {
    if (opts.json) {
      const failure = formatCliJsonFailure(`Hook "${hookName}" not found.`);
      return JSON.stringify({ ...failure, hook: hookName }, null, 2);
    }
    return `Hook "${sanitizeTerminalText(hookName)}" not found. Run \`${formatCliCommand("openclaw hooks list")}\` to see available hooks.`;
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

  const emoji = sanitizeTerminalText(hook.emoji ?? decorativeEmoji("🔗"));
  const lines = [
    `${emoji ? `${emoji} ` : ""}${theme.heading(sanitizeTerminalText(hook.name))} ${formatHookStatus(hook, true)}`,
    "",
    sanitizeCliDescriptorText(hook.description),
    "",
    theme.heading("Details:"),
    `${theme.muted("  Source:")} ${sanitizeTerminalText(hook.source)}${hook.managedByPlugin ? ` (${sanitizeTerminalText(hook.pluginId ?? "unknown")})` : ""}`,
    `${theme.muted("  Path:")} ${sanitizeTerminalText(shortenHomePath(hook.filePath))}`,
    `${theme.muted("  Handler:")} ${sanitizeTerminalText(shortenHomePath(hook.handlerPath))}`,
  ];
  if (hook.homepage) {
    lines.push(`${theme.muted("  Homepage:")} ${sanitizeTerminalText(hook.homepage)}`);
  }
  if (hook.events.length > 0) {
    lines.push(`${theme.muted("  Events:")} ${sanitizeTerminalText(hook.events.join(", "))}`);
  }
  if (hook.unknownEvents.length > 0) {
    lines.push(
      theme.warn(
        `  ⚠ Event${hook.unknownEvents.length === 1 ? "" : "s"} not emitted by core (likely typo): ${sanitizeTerminalText(hook.unknownEvents.join(", "))}`,
      ),
    );
  }
  if (hook.managedByPlugin) {
    lines.push(theme.muted("  Managed by plugin; enable/disable via hooks CLI not available."));
  }
  if (hook.blockedReason) {
    lines.push(`${theme.muted("  Blocked reason:")} ${sanitizeTerminalText(hook.blockedReason)}`);
  }

  lines.push(...formatCliRequirements(hook, HOOK_REQUIREMENT_GROUPS, hook.configChecks));

  return lines.join("\n");
}

function formatHooksCheck(report: HookStatusReport, opts: HooksReportOptions): string {
  const eligible = report.hooks.filter((h) => h.loadable);
  const notEligible = report.hooks.filter((h) => !h.loadable);
  if (opts.json) {
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

  const lines = [
    theme.heading("Hooks Status"),
    "",
    `${theme.muted("Total hooks:")} ${report.hooks.length}`,
    `${theme.success("Ready:")} ${eligible.length}`,
    `${theme.warn("Not ready:")} ${notEligible.length}`,
  ];

  if (notEligible.length > 0) {
    lines.push("");
    lines.push(theme.heading("Hooks not ready:"));
    for (const hook of notEligible) {
      const reasons = formatHookMissingRequirements(hook);
      if (hook.blockedReason && hook.blockedReason !== "missing requirements") {
        reasons.unshift(hook.blockedReason);
      }
      const emoji = hook.emoji ?? decorativeEmoji("🔗");
      lines.push(
        sanitizeTerminalText(`  ${emoji ? `${emoji} ` : ""}${hook.name} - ${reasons.join("; ")}`),
      );
    }
  }

  return lines.join("\n");
}

const GATEWAY_HOOKS_STATUS_TIMEOUT_MS = 1_500;

type HooksReportTarget = ReturnType<typeof resolveHooksReportTarget>;

function resolveHooksReportTarget(config: OpenClawConfig, rawAgentId?: string) {
  const requested = rawAgentId?.trim();
  if (rawAgentId !== undefined && !requested) {
    throw new Error("--agent must not be blank");
  }
  const requestedAgentId = requested ? normalizeAgentId(requested) : undefined;
  if (requestedAgentId) {
    resolveConfiguredAgentId(config, requestedAgentId);
  }
  const agentId =
    requestedAgentId ??
    tryResolveLegacyCompatibilityAgentId(config) ??
    resolveDefaultAgentId(config, {
      surface: "hooks status reporting",
      hint: "Pass --agent <id> to select a configured agent.",
    });
  return { agentId, workspaceDir: resolveAgentWorkspaceDir(config, agentId) };
}

async function withHooksReport<T>(
  config: OpenClawConfig,
  target: HooksReportTarget,
  consume: (report: HookStatusReport) => T,
): Promise<T> {
  // Plugin-managed and workspace hooks share one resolved policy view for status/actions.
  const workspaceDir = target.workspaceDir;
  const workspaceEntries = loadWorkspaceHookEntries(workspaceDir, { config });
  // Native plugin hooks only exist after registration. Match the Gateway's startup
  // plan so active hooks remain visible without executing unrelated installed plugins.
  const startup = loadGatewayStartupPluginPlanWithMetadata({
    config,
    workspaceDir,
    env: process.env,
  });
  return withPluginDiagnosticsReport(
    {
      config,
      workspaceDir,
      onlyPluginIds: startup.plan.pluginIds,
      metadataSnapshot: startup.metadataSnapshot,
    },
    (pluginReport) => {
      const pluginEntries = pluginReport.hooks.map((hook) => hook.entry);
      const entries = resolveHookEntries([...pluginEntries, ...workspaceEntries]);
      return consume(buildWorkspaceHookStatus(workspaceDir, { config, entries }));
    },
  );
}

async function loadHooksReport<T>(
  agentId: string | undefined,
  consume: (report: HookStatusReport) => T,
): Promise<T> {
  const config = await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })();
  const target = resolveHooksReportTarget(config, agentId);
  const { callGateway } = await import("../gateway/call.js");
  let report: HookStatusReport;
  try {
    report = await callGateway<HookStatusReport>({
      config,
      method: "hooks.status",
      params: { agentId: target.agentId },
      timeoutMs: GATEWAY_HOOKS_STATUS_TIMEOUT_MS,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  } catch (error) {
    if (
      !(await canFallbackToImplicitLocalGateway({
        config,
        error,
        legacyMethod: "hooks.status",
        legacyAgentId: true,
      }))
    ) {
      throw error;
    }
    // Only implicit local Gateways may use offline or older-Gateway discovery.
    return withHooksReport(config, target, consume);
  }
  return consume(report);
}

function resolveHookSelection(
  report: HookStatusReport,
  hookName: string,
): HookStatusEntry | undefined {
  // A metadata key may alias another hook's name; exact names always win.
  const nameMatches = report.hooks.filter((hook) => hook.name === hookName);
  const matches =
    nameMatches.length > 0 ? nameMatches : report.hooks.filter((hook) => hook.hookKey === hookName);
  if (matches.length > 1) {
    const candidates = summarizeStringEntries({
      entries: matches.map((hook) => `${hook.name} (${hook.hookKey})`),
      limit: 5,
    });
    throw new Error(
      `Hook "${hookName}" is ambiguous; matches: ${candidates}. Use a unique hook name or hook key.`,
    );
  }
  return matches[0];
}

function writeHooksOutput(value: string, json: boolean | undefined): void {
  if (json) {
    defaultRuntime.writeStdout(value);
    return;
  }
  defaultRuntime.log(value);
}

async function runOneShotHooksCliAction(
  action: () => Promise<number | void>,
  failureOwner: "command" | "root" = "command",
): Promise<void> {
  const result = await action().catch((err: unknown) => {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    // Owner remedies span lines (Config:/Fix:); keep the breaks, strip controls per line.
    const humanOutput = `${theme.error("Error:")} ${message.split("\n").map(sanitizeTerminalText).join("\n")}`;
    if (failureOwner === "root") {
      throw new ExpectedCliError({ message, humanOutput, machineOutput: message });
    }
    defaultRuntime.error(humanOutput);
    defaultRuntime.exit(1);
    throw new Error("unreachable");
  });
  const exitCode = typeof result === "number" ? result : 0;
  // CLI setup and handlers can leave ref'd handles behind. Defer exit until
  // runCli finishes shared teardown and drains both output streams.
  requestExitAfterOneShotOutput(defaultRuntime, exitCode);
}

const HOOK_SOURCES: ReadonlySet<string> = new Set([
  "openclaw-bundled",
  "openclaw-managed",
  "openclaw-workspace",
  "openclaw-plugin",
]);

function resolveHookHandlerExportName(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const frontmatter = parseHookFrontmatter(content);
    return resolveHookManifestMetadata(frontmatter)?.export?.trim() || "default";
  } catch {
    return "default";
  }
}

function asHookSource(source: string): HookSource {
  if (HOOK_SOURCES.has(source)) {
    return source as HookSource; // SAFETY: caller already validated source against HookSource enum values.
  }
  // Discovery always sets a known source; fall back so smoke-load still runs.
  return "openclaw-workspace";
}

type HooksTestOptions = HooksReportOptions & {
  event?: string;
};

type HooksTestResult = {
  name: string;
  hookKey: string;
  loadOk: boolean;
  eligible: boolean;
  enabledByConfig: boolean;
  events: string[];
  unknownEvents: string[];
  source: string;
  pluginId?: string;
  handlerPath: string;
  exportName: string;
  unsupported?: boolean;
  error?: string;
  eventMatch?: { event: string; matched: boolean };
};

function formatHooksTest(result: HooksTestResult, opts: HooksTestOptions): string {
  if (opts.json) {
    return JSON.stringify(result, null, 2);
  }
  const title = sanitizeTerminalText(result.name);
  if (result.unsupported) {
    return [
      theme.warn(`⚠ ${title} — unsupported`),
      theme.muted(
        `  Plugin-managed hooks cannot be smoke-loaded here; test via the owning plugin (${sanitizeTerminalText(result.pluginId ?? "unknown")}).`,
      ),
    ].join("\n");
  }
  const status = result.loadOk
    ? theme.success(`✓ ${title} — loadOk`)
    : theme.error(`✗ ${title} — load failed`);
  const lines = [status];
  if (result.events.length > 0) {
    lines.push(`${theme.muted("  Events:")} ${sanitizeTerminalText(result.events.join(", "))}`);
  }
  if (result.unknownEvents.length > 0) {
    lines.push(
      theme.warn(`  ⚠ Unknown events: ${sanitizeTerminalText(result.unknownEvents.join(", "))}`),
    );
  }
  lines.push(
    `${theme.muted("  Handler:")} ${sanitizeTerminalText(shortenHomePath(result.handlerPath))}`,
  );
  lines.push(`${theme.muted("  Export:")} ${sanitizeTerminalText(result.exportName)}`);
  if (result.eventMatch) {
    lines.push(
      result.eventMatch.matched
        ? theme.success(`  Event ${sanitizeTerminalText(result.eventMatch.event)}: matched`)
        : theme.warn(
            `  Event ${sanitizeTerminalText(result.eventMatch.event)}: not in declared set`,
          ),
    );
  }
  if (result.error) {
    lines.push(`${theme.muted("  Error:")} ${sanitizeTerminalText(result.error)}`);
  }
  return lines.join("\n");
}

async function runHooksTest(
  hookName: string,
  opts: HooksTestOptions,
): Promise<{ output: string; exitCode: number }> {
  const config = await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })();
  const target = resolveHooksReportTarget(config, opts.agent);
  // Local discovery only — smoke-load needs on-disk handler paths and must not require Gateway.
  const report = await withHooksReport(config, target, (status) => status);
  const hook = resolveHookSelection(report, hookName);
  if (!hook) {
    if (opts.json) {
      const failure = formatCliJsonFailure(`Hook "${hookName}" not found.`);
      return {
        output: JSON.stringify({ ...failure, hook: hookName, loadOk: false }, null, 2),
        exitCode: 1,
      };
    }
    return {
      output: `Hook "${sanitizeTerminalText(hookName)}" not found. Run \`${formatCliCommand("openclaw hooks list")}\` to see available hooks.`,
      exitCode: 1,
    };
  }

  const requestedEvent = opts.event?.trim();
  if (opts.event !== undefined && !requestedEvent) {
    throw new Error("--event must not be blank");
  }
  const eventMatch = requestedEvent
    ? { event: requestedEvent, matched: hook.events.includes(requestedEvent) }
    : undefined;

  if (hook.managedByPlugin) {
    const result: HooksTestResult = {
      name: hook.name,
      hookKey: hook.hookKey,
      loadOk: false,
      eligible: hook.loadable,
      enabledByConfig: hook.enabledByConfig,
      events: hook.events,
      unknownEvents: hook.unknownEvents,
      source: hook.source,
      pluginId: hook.pluginId,
      handlerPath: hook.handlerPath,
      exportName: resolveHookHandlerExportName(hook.filePath),
      unsupported: true,
      error: `Hook "${hook.name}" is managed by plugin "${hook.pluginId ?? "unknown"}"; smoke-load is unsupported. Test via the owning plugin.`,
      eventMatch,
    };
    return { output: formatHooksTest(result, opts), exitCode: 1 };
  }

  // Re-resolve with Gateway-style precedence that retains invalid winning sources, so a
  // managed/workspace HOOK.md without a readable handler cannot fall through to a bundled twin.
  const discovery = prepareWorkspaceHookEntries(target.workspaceDir, {
    config,
    managedHooksDir: path.join(resolveConfigDir(), "hooks"),
    preserveMissingHandlers: true,
  });
  const winningSource = discovery.sources.find((candidate) => {
    if (candidate.hook.name === hook.name || candidate.hook.name === hookName) {
      return true;
    }
    const key = resolveHookKey(candidate.hook.name, { metadata: candidate.metadata });
    return key === hook.hookKey || key === hookName;
  });
  const matched = discovery.entries.find((entry) => entry.hook.name === hook.name);
  // Present in precedence sources but absent from executable entries => missing/invalid handler.
  if (winningSource && !matched) {
    const result: HooksTestResult = {
      name: hook.name,
      hookKey: hook.hookKey,
      loadOk: false,
      eligible: false,
      enabledByConfig: hook.enabledByConfig,
      events: hook.events,
      unknownEvents: hook.unknownEvents,
      source: winningSource.hook.source,
      pluginId: (winningSource.hook as Hook).pluginId, // SAFETY: discovery entries retain optional pluginId at runtime beyond the Pick type.
      handlerPath: "",
      exportName: resolveHookHandlerExportName(winningSource.filePath),
      error: `Hook "${hook.name}" has no readable handler at ${winningSource.filePath}`,
      eventMatch,
    };
    return { output: formatHooksTest(result, opts), exitCode: 1 };
  }
  const smokeTarget = matched
    ? {
        ...hook,
        source: matched.hook.source,
        pluginId: matched.hook.pluginId,
        filePath: matched.hook.filePath,
        baseDir: matched.hook.baseDir,
        handlerPath: matched.hook.handlerPath,
        hookKey: resolveHookKey(matched.hook.name, matched),
      }
    : hook;

  const exportName = resolveHookHandlerExportName(smokeTarget.filePath);
  const smoke = await smokeLoadHookHandler({
    handlerPath: smokeTarget.handlerPath,
    baseDir: smokeTarget.baseDir,
    source: asHookSource(smokeTarget.source),
    exportName,
  });
  const result: HooksTestResult = {
    name: smokeTarget.name,
    hookKey: smokeTarget.hookKey,
    loadOk: smoke.loadOk,
    eligible: smokeTarget.loadable,
    enabledByConfig: smokeTarget.enabledByConfig,
    events: smokeTarget.events,
    unknownEvents: smokeTarget.unknownEvents,
    source: smokeTarget.source,
    pluginId: smokeTarget.pluginId,
    handlerPath: smoke.handlerPath,
    exportName: smoke.exportName,
    error: smoke.error,
    eventMatch,
  };
  return { output: formatHooksTest(result, opts), exitCode: smoke.loadOk ? 0 : 1 };
}

export function registerHooksCli(program: Command): void {
  const hooks = program
    .command("hooks")
    .description("Manage internal agent hooks")
    .option("--agent <id>", "Agent id to inspect")
    .option("--json", "Output as JSON", false)
    .addHelpText("after", () => formatDocsHelp("/cli/hooks"));
  const hasJsonOutput = (opts: { json?: boolean } | undefined): boolean =>
    Boolean(opts?.json || hooks.opts<{ json?: boolean }>().json);
  hooks.hook("preAction", (_thisCommand, actionCommand) => {
    const parentAgent = hooks.opts<{ agent?: string }>().agent;
    if (parentAgent !== undefined && !parentAgent.trim()) {
      throw new Error("--agent must not be blank");
    }
    if (
      parentAgent &&
      actionCommand !== hooks &&
      !new Set(["list", "info", "check", "test", "enable", "disable"]).has(actionCommand.name())
    ) {
      throw new Error(
        `openclaw hooks ${actionCommand.name()} does not support --agent; the option only selects an owner for read-only hook reports.`,
      );
    }
  });

  const reportAction =
    (format: (report: HookStatusReport, opts: HooksListOptions) => string) =>
    (opts: HooksListOptions, command: Command) =>
      runOneShotHooksCliAction(async () => {
        const json = hasJsonOutput(opts);
        const output = await loadHooksReport(
          resolveOptionFromCommand<string>(command, "agent"),
          (report) => format(report, { ...opts, json }),
        );
        writeHooksOutput(output, json);
      }, "root");
  const runHooksList = reportAction(formatHooksList);

  hooks
    .command("list")
    .description("List all hooks")
    .option("--agent <id>", "Agent id to inspect")
    .option("--eligible", "Show only eligible hooks", false)
    .option("--json", "Output as JSON", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(runHooksList);

  hooks
    .command("info <name>")
    .description("Show detailed information about a hook")
    .option("--agent <id>", "Agent id to inspect")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts: HooksReportOptions, command: Command) =>
      runOneShotHooksCliAction(async () => {
        const json = hasJsonOutput(opts);
        const result = await loadHooksReport(
          resolveOptionFromCommand<string>(command, "agent"),
          (report) => {
            const hook = resolveHookSelection(report, name);
            return {
              output: formatHookInfo(hook, name, { ...opts, json }),
              exitCode: hook ? 0 : 1,
            };
          },
        );
        writeHooksOutput(result.output, json);
        return result.exitCode;
      }, "root"),
    );

  hooks
    .command("check")
    .description("Check hooks eligibility status")
    .option("--agent <id>", "Agent id to inspect")
    .option("--json", "Output as JSON", false)
    .action(reportAction(formatHooksCheck));

  hooks
    .command("test <name>")
    .description("Smoke-load a hook handler without enabling it")
    .option("--agent <id>", "Agent id to inspect")
    .option("--json", "Output as JSON", false)
    .option(
      "--event <eventName>",
      "Report whether the event is in the hook's declared set (does not invoke the handler)",
    )
    .action(async (name: string, opts: HooksTestOptions, command: Command) =>
      runOneShotHooksCliAction(async () => {
        const json = hasJsonOutput(opts);
        const result = await runHooksTest(name, {
          ...opts,
          agent: resolveOptionFromCommand<string>(command, "agent"),
          json,
        });
        writeHooksOutput(result.output, json);
        return result.exitCode;
      }, "root"),
    );

  for (const enabled of [true, false]) {
    hooks
      .command(`${enabled ? "enable" : "disable"} <name>`)
      .description(enabled ? "Enable a hook" : "Disable a hook")
      .option("--agent <id>", "Agent id whose workspace to inspect")
      .action(async (name, _opts: { agent?: string }, command: Command) =>
        runOneShotHooksCliAction(async () => {
          const agentId = resolveOptionFromCommand<string>(command, "agent");
          return await runWithLocalStateOwner({
            method: `hooks.${enabled ? "enable" : "disable"}`,
            params: {},
            target: `hook "${name}"`,
            onForeignOwner: "refuse",
            runLocal: async ({ assertCurrent }) => {
              const committed = await transformConfigFile({
                writeOptions: { assertConfigPathForWrite: assertCurrent },
                transform: (config) =>
                  withHooksReport(config, resolveHooksReportTarget(config, agentId), (report) => {
                    const hook = resolveHookSelection(report, name);
                    if (!hook) {
                      throw new Error(
                        `Hook "${name}" not found. Run \`${formatCliCommand("openclaw hooks list")}\` to see available hooks.`,
                      );
                    }
                    if (hook.managedByPlugin) {
                      throw new Error(
                        `Hook "${name}" is managed by plugin "${hook.pluginId ?? "unknown"}" and cannot be enabled/disabled.`,
                      );
                    }
                    if (enabled && !hook.requirementsSatisfied) {
                      const missing = formatHookMissingSummary(hook, 3);
                      const installHint = hook.install.length
                        ? ` Install options: ${summarizeStringEntries({
                            entries: hook.install.map((option) => option.label),
                            limit: 3,
                          })}.`
                        : "";
                      throw new Error(
                        `Hook "${name}" is not eligible; missing ${missing}.${installHint} Run \`${formatCliCommand(`openclaw hooks info ${name}`)}\` for details.`,
                      );
                    }
                    const entries = { ...config.hooks?.internal?.entries };
                    entries[hook.hookKey] = { ...entries[hook.hookKey], enabled };
                    const nextConfig: OpenClawConfig = {
                      ...config,
                      hooks: {
                        ...config.hooks,
                        internal: {
                          ...config.hooks?.internal,
                          ...(enabled ? { enabled: true } : {}),
                          entries,
                        },
                      },
                    };
                    return { nextConfig, result: { name: hook.name, emoji: hook.emoji } };
                  }),
              });
              const selectedHook = expectDefined(committed.result, "hook mutation result");
              const prefix = enabled
                ? `${theme.success("✓")} Enabled hook:`
                : theme.warn(decorativePrefix("⏸", "Disabled hook:"));
              const formattedName = selectedHook.emoji
                ? `${selectedHook.emoji} ${theme.command(selectedHook.name)}`
                : decorativePrefix("🔗", theme.command(selectedHook.name));
              defaultRuntime.log(`${prefix} ${formattedName}`);
            },
          });
        }),
      );
  }

  hooks
    .command("relay", { hidden: true })
    .description("Internal native harness hook relay")
    .requiredOption("--provider <provider>", "Native harness provider")
    .requiredOption("--relay-id <id>", "Native hook relay id")
    .option("--state-db <path>", "Shared state database path")
    .option("--remote-credential <path>", "Dedicated harness relay credential file")
    .option("--generation <generation>", "Native hook relay registration generation")
    .requiredOption("--event <event>", "Native hook event")
    .option(
      "--pre-tool-use-unavailable <mode>",
      "PreToolUse fallback mode when the originating relay is unavailable",
    )
    .option("--timeout <ms>", "Gateway timeout in ms", "5000")
    .action(async (opts: NativeHookRelayCliOptions) =>
      runOneShotHooksCliAction(() => runNativeHookRelayCli(opts)),
    );

  hooks
    .command("install")
    .description("Deprecated: install a hook pack via `openclaw plugins install`")
    .argument("<path-or-spec>", "Path to a hook pack or npm package spec")
    .option("-l, --link", "Link a local path instead of copying", false)
    .option("--pin", "Record npm installs as exact resolved <name>@<version>", false)
    .option("--force", "Confirm non-ClawHub sources and overwrite an existing hook pack", false)
    .option(
      "--acknowledge-install-policy-warning",
      "Acknowledge security.installPolicy warnings without prompting; blocks and failures remain terminal",
      false,
    )
    .action(async (raw: string, opts: RunPluginInstallCommandParams["opts"]) => {
      const { runPluginInstallCommand } = await import("./plugins-install-command.js");
      defaultRuntime.log(
        theme.warn("`openclaw hooks install` is deprecated; use `openclaw plugins install`."),
      );
      await runPluginInstallCommand({
        raw,
        opts,
        allowInstallPolicyWarningPrompt: true,
        invalidateRuntimeCache: false,
      });
    });

  hooks
    .command("update")
    .description("Deprecated: update hook packs via `openclaw plugins update`")
    .argument("[id]", "Hook pack id (omit with --all)")
    .option("--all", "Update all tracked hooks", false)
    .option("--dry-run", "Show what would change without writing", false)
    .option(
      "--acknowledge-install-policy-warning",
      "Acknowledge security.installPolicy warnings without prompting; blocks and failures remain terminal",
      false,
    )
    .action(async (id: string | undefined, opts: RunPluginUpdateCommandParams["opts"]) => {
      const { runPluginUpdateCommand } = await import("./plugins-update-command.js");
      defaultRuntime.log(
        theme.warn("`openclaw hooks update` is deprecated; use `openclaw plugins update`."),
      );
      await runPluginUpdateCommand({ ids: id ? [id] : [], opts });
    });

  hooks.action(runHooksList);
}
