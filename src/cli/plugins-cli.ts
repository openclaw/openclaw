import fs from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";

import { loadConfig, writeConfigFile } from "../config/config.js";
import type { PluginRecord } from "../plugins/registry.js";
import { buildPluginStatusReport } from "../plugins/status.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath } from "../utils.js";

export type PluginsListOptions = {
  json?: boolean;
  enabled?: boolean;
  verbose?: boolean;
};

export type PluginInfoOptions = {
  json?: boolean;
};

function formatPluginLine(plugin: PluginRecord, verbose = false): string {
  const status =
    plugin.status === "loaded"
      ? chalk.green("✓")
      : plugin.status === "disabled"
        ? chalk.yellow("disabled")
        : chalk.red("error");
  const name = plugin.name ? chalk.white(plugin.name) : chalk.white(plugin.id);
  const idSuffix =
    plugin.name !== plugin.id ? chalk.gray(` (${plugin.id})`) : "";
  const desc = plugin.description
    ? chalk.gray(
        plugin.description.length > 60
          ? `${plugin.description.slice(0, 57)}...`
          : plugin.description,
      )
    : chalk.gray("(no description)");

  if (!verbose) {
    return `${name}${idSuffix} ${status} - ${desc}`;
  }

  const parts = [
    `${name}${idSuffix} ${status}`,
    `  source: ${chalk.gray(plugin.source)}`,
    `  origin: ${plugin.origin}`,
  ];
  if (plugin.version) parts.push(`  version: ${plugin.version}`);
  if (plugin.error) parts.push(chalk.red(`  error: ${plugin.error}`));
  return parts.join("\n");
}

export function registerPluginsCli(program: Command) {
  const plugins = program
    .command("plugins")
    .description("Manage Clawdbot plugins/extensions");

  plugins
    .command("list")
    .description("List discovered plugins")
    .option("--json", "Print JSON")
    .option("--enabled", "Only show enabled plugins", false)
    .option("--verbose", "Show detailed entries", false)
    .action((opts: PluginsListOptions) => {
      const report = buildPluginStatusReport();
      const list = opts.enabled
        ? report.plugins.filter((p) => p.status === "loaded")
        : report.plugins;

      if (opts.json) {
        const payload = {
          workspaceDir: report.workspaceDir,
          plugins: list,
          diagnostics: report.diagnostics,
        };
        defaultRuntime.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (list.length === 0) {
        defaultRuntime.log("No plugins found.");
        return;
      }

      const lines: string[] = [];
      const loaded = list.filter((p) => p.status === "loaded").length;
      lines.push(
        `${chalk.bold.cyan("Plugins")} ${chalk.gray(`(${loaded}/${list.length} loaded)`)}`,
      );
      lines.push("");
      for (const plugin of list) {
        lines.push(formatPluginLine(plugin, opts.verbose));
        if (opts.verbose) lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    });

  plugins
    .command("info")
    .description("Show plugin details")
    .argument("<id>", "Plugin id")
    .option("--json", "Print JSON")
    .action((id: string, opts: PluginInfoOptions) => {
      const report = buildPluginStatusReport();
      const plugin = report.plugins.find((p) => p.id === id || p.name === id);
      if (!plugin) {
        defaultRuntime.error(`Plugin not found: ${id}`);
        process.exit(1);
      }

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(plugin, null, 2));
        return;
      }

      const lines: string[] = [];
      lines.push(chalk.bold.cyan(plugin.name || plugin.id));
      if (plugin.name && plugin.name !== plugin.id) {
        lines.push(chalk.gray(`id: ${plugin.id}`));
      }
      if (plugin.description) lines.push(plugin.description);
      lines.push("");
      lines.push(`Status: ${plugin.status}`);
      lines.push(`Source: ${plugin.source}`);
      lines.push(`Origin: ${plugin.origin}`);
      if (plugin.version) lines.push(`Version: ${plugin.version}`);
      if (plugin.toolNames.length > 0) {
        lines.push(`Tools: ${plugin.toolNames.join(", ")}`);
      }
      if (plugin.gatewayMethods.length > 0) {
        lines.push(`Gateway methods: ${plugin.gatewayMethods.join(", ")}`);
      }
      if (plugin.cliCommands.length > 0) {
        lines.push(`CLI commands: ${plugin.cliCommands.join(", ")}`);
      }
      if (plugin.services.length > 0) {
        lines.push(`Services: ${plugin.services.join(", ")}`);
      }
      if (plugin.error) lines.push(chalk.red(`Error: ${plugin.error}`));
      defaultRuntime.log(lines.join("\n"));
    });

  plugins
    .command("enable")
    .description("Enable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const next = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [id]: {
              ...(
                cfg.plugins?.entries as
                  | Record<string, { enabled?: boolean }>
                  | undefined
              )?.[id],
              enabled: true,
            },
          },
        },
      };
      await writeConfigFile(next);
      defaultRuntime.log(
        `Enabled plugin "${id}". Restart the gateway to apply.`,
      );
    });

  plugins
    .command("disable")
    .description("Disable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const next = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            [id]: {
              ...(
                cfg.plugins?.entries as
                  | Record<string, { enabled?: boolean }>
                  | undefined
              )?.[id],
              enabled: false,
            },
          },
        },
      };
      await writeConfigFile(next);
      defaultRuntime.log(
        `Disabled plugin "${id}". Restart the gateway to apply.`,
      );
    });

  plugins
    .command("install")
    .description("Add a plugin path to clawdbot.json")
    .argument("<path>", "Path to a plugin file or directory")
    .action(async (rawPath: string) => {
      const resolved = resolveUserPath(rawPath);
      if (!fs.existsSync(resolved)) {
        defaultRuntime.error(`Path not found: ${resolved}`);
        process.exit(1);
      }
      const cfg = loadConfig();
      const existing = cfg.plugins?.load?.paths ?? [];
      const merged = Array.from(new Set([...existing, resolved]));
      const next = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          load: {
            ...cfg.plugins?.load,
            paths: merged,
          },
        },
      };
      await writeConfigFile(next);
      defaultRuntime.log(`Added plugin path: ${resolved}`);
      defaultRuntime.log(`Restart the gateway to load plugins.`);
    });

  plugins
    .command("doctor")
    .description("Report plugin load issues")
    .action(() => {
      const report = buildPluginStatusReport();
      const errors = report.plugins.filter((p) => p.status === "error");
      const diags = report.diagnostics.filter((d) => d.level === "error");

      if (errors.length === 0 && diags.length === 0) {
        defaultRuntime.log("No plugin issues detected.");
        return;
      }

      const lines: string[] = [];
      if (errors.length > 0) {
        lines.push(chalk.bold.red("Plugin errors:"));
        for (const entry of errors) {
          lines.push(
            `- ${entry.id}: ${entry.error ?? "failed to load"} (${entry.source})`,
          );
        }
      }
      if (diags.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(chalk.bold.yellow("Diagnostics:"));
        for (const diag of diags) {
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          lines.push(`- ${target}${diag.message}`);
        }
      }
      const docs = formatDocsLink("/plugin", "docs.clawd.bot/plugin");
      lines.push("");
      lines.push(`${theme.muted("Docs:")} ${docs}`);
      defaultRuntime.log(lines.join("\n"));
    });
}
