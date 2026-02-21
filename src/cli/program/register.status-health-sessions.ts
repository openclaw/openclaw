import type { Command } from "commander";
import { healthCommand } from "../../commands/health.js";
import { sessionsCommand } from "../../commands/sessions.js";
import { statusCommand } from "../../commands/status.js";
import { setVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { t } from "../../shared/i18n.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";
import { parsePositiveIntOrUndefined } from "./helpers.js";

function resolveVerbose(opts: { verbose?: boolean; debug?: boolean }): boolean {
  return Boolean(opts.verbose || opts.debug);
}

function parseTimeoutMs(timeout: unknown): number | null | undefined {
  const parsed = parsePositiveIntOrUndefined(timeout);
  if (timeout !== undefined && parsed === undefined) {
    defaultRuntime.error("--timeout must be a positive integer (milliseconds)");
    defaultRuntime.exit(1);
    return null;
  }
  return parsed;
}

export function registerStatusHealthSessionsCommands(program: Command) {
  program
    .command("status")
    .description(t("cli.status.description"))
    .option("--json", "Output JSON instead of text", false)
    .option("--all", "Full diagnosis (read-only, pasteable)", false)
    .option("--usage", "Show model provider usage/quota snapshots", false)
    .option("--deep", "Probe channels (WhatsApp Web + Telegram + Discord + Slack + Signal)", false)
    .option("--timeout <ms>", "Probe timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .option("--debug", "Alias for --verbose", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading(t("cli.common.examples"))}\n${formatHelpExamples([
          ["openclaw status", t("cli.status.example_basic")],
          ["openclaw status --all", t("cli.status.example_all")],
          ["openclaw status --json", t("cli.status.example_json")],
          ["openclaw status --usage", t("cli.status.example_usage")],
          ["openclaw status --deep", t("cli.status.example_deep")],
          ["openclaw status --deep --timeout 5000", t("cli.status.example_timeout")],
        ])}`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted(t("cli.common.docs"))} ${formatDocsLink("/cli/status", "docs.openclaw.ai/cli/status")}\n`,
    )
    .action(async (opts) => {
      const verbose = resolveVerbose(opts);
      setVerbose(verbose);
      const timeout = parseTimeoutMs(opts.timeout);
      if (timeout === null) {
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        await statusCommand(
          {
            json: Boolean(opts.json),
            all: Boolean(opts.all),
            deep: Boolean(opts.deep),
            usage: Boolean(opts.usage),
            timeoutMs: timeout,
            verbose,
          },
          defaultRuntime,
        );
      });
    });

  program
    .command("health")
    .description(t("cli.health.description"))
    .option("--json", "Output JSON instead of text", false)
    .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .option("--debug", "Alias for --verbose", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted(t("cli.common.docs"))} ${formatDocsLink("/cli/health", "docs.openclaw.ai/cli/health")}\n`,
    )
    .action(async (opts) => {
      const verbose = resolveVerbose(opts);
      setVerbose(verbose);
      const timeout = parseTimeoutMs(opts.timeout);
      if (timeout === null) {
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        await healthCommand(
          {
            json: Boolean(opts.json),
            timeoutMs: timeout,
            verbose,
          },
          defaultRuntime,
        );
      });
    });

  program
    .command("sessions")
    .description(t("cli.sessions.description"))
    .option("--json", "Output as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .option("--store <path>", "Path to session store (default: resolved from config)")
    .option("--active <minutes>", "Only show sessions updated within the past N minutes")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading(t("cli.common.examples"))}\n${formatHelpExamples([
          ["openclaw sessions", t("cli.sessions.example_basic")],
          ["openclaw sessions --active 120", t("cli.sessions.example_active")],
          ["openclaw sessions --json", t("cli.sessions.example_json")],
          ["openclaw sessions --store ./tmp/sessions.json", t("cli.sessions.example_store")],
        ])}\n\n${theme.muted(t("cli.sessions.token_usage_hint"))}`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted(t("cli.common.docs"))} ${formatDocsLink("/cli/sessions", "docs.openclaw.ai/cli/sessions")}\n`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      await sessionsCommand(
        {
          json: Boolean(opts.json),
          store: opts.store as string | undefined,
          active: opts.active as string | undefined,
        },
        defaultRuntime,
      );
    });
}
