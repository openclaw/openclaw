import {
  decorativeEmoji,
  decorativePrefix,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import { summarizeStringEntries } from "../shared/string-sample.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { formatCliRequirements } from "./skills-hooks-cli.format.js";

export type HooksReportOptions = {
  agent?: string;
  json?: boolean;
};

export type HooksListOptions = HooksReportOptions & {
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
      ? hook.blockedReason
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

export function formatHookMissingSummary(hook: HookStatusEntry, itemLimit?: number): string {
  const missing = formatHookMissingRequirements(hook, itemLimit);
  if (hook.enabledByConfig && hook.blockedReason && hook.blockedReason !== "missing requirements") {
    missing.unshift(hook.blockedReason);
  }
  return missing.join("; ");
}

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
    return opts.eligible
      ? `No eligible hooks found. Run \`${formatCliCommand("openclaw hooks list")}\` to see all hooks.`
      : "No hooks found.";
  }

  const eligible = hooks.filter((h) => h.loadable);
  const tableWidth = getTerminalTableWidth();
  const rows = hooks.map((hook) => {
    const emoji = hook.emoji ?? decorativeEmoji("🔗");
    const name = theme.command(hook.name);
    return {
      Status: formatHookStatus(hook),
      Hook: emoji ? `${emoji} ${name}` : name,
      Description: theme.muted(hook.description),
      Source: hook.managedByPlugin ? `plugin:${hook.pluginId ?? "unknown"}` : hook.source,
      Missing: opts.verbose ? theme.warn(formatHookMissingSummary(hook)) : "",
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

  return [
    `${theme.heading("Hooks")} ${theme.muted(`(${eligible.length}/${hooks.length} ready)`)}`,
    renderTable({
      width: tableWidth,
      columns,
      rows,
    }).trimEnd(),
  ].join("\n");
}

export function formatHookInfo(
  hook: HookStatusEntry | undefined,
  hookName: string,
  opts: HooksReportOptions,
): string {
  if (!hook) {
    if (opts.json) {
      const failure = formatCliJsonFailure(`Hook "${hookName}" not found.`);
      return JSON.stringify({ ...failure, hook: hookName }, null, 2);
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

  const emoji = hook.emoji ?? decorativeEmoji("🔗");
  const lines = [
    `${emoji ? `${emoji} ` : ""}${theme.heading(hook.name)} ${formatHookStatus(hook, true)}`,
    "",
    hook.description,
    "",
    theme.heading("Details:"),
    `${theme.muted("  Source:")} ${hook.source}${hook.managedByPlugin ? ` (${hook.pluginId ?? "unknown"})` : ""}`,
    `${theme.muted("  Path:")} ${shortenHomePath(hook.filePath)}`,
    `${theme.muted("  Handler:")} ${shortenHomePath(hook.handlerPath)}`,
  ];
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

  lines.push(...formatCliRequirements(hook, HOOK_REQUIREMENT_GROUPS, hook.configChecks));

  return lines.join("\n");
}

export function formatHooksCheck(report: HookStatusReport, opts: HooksReportOptions): string {
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
      lines.push(`  ${emoji ? `${emoji} ` : ""}${hook.name} - ${reasons.join("; ")}`);
    }
  }

  return lines.join("\n");
}
