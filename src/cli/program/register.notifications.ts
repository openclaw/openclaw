import type { Command } from "commander";
import {
  notificationsClearCommand,
  notificationsListCommand,
  notificationsPrefsCommand,
  notificationsReadCommand,
} from "../../commands/notifications.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerNotificationsCommands(program: Command) {
  const notif = program
    .command("notifications")
    .alias("notif")
    .description("Manage push notifications and preferences");

  notif
    .command("list")
    .description("List notifications")
    .option("--json", "Output as JSON", false)
    .option("--unread", "Show only unread notifications", false)
    .option("--category <name>", "Filter by category (message, agent-complete, tool-approval, error, system)")
    .option("--channel <name>", "Filter by channel")
    .option("--agent <id>", "Filter by agent")
    .option("--limit <n>", "Maximum results", "50")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot notifications list", "List all notifications."],
          ["moltbot notifications list --unread", "Show only unread."],
          ["moltbot notifications list --category error", "Show only errors."],
          ["moltbot notif list --json", "JSON output."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await notificationsListCommand(
          {
            json: Boolean(opts.json),
            unread: Boolean(opts.unread),
            category: opts.category as string | undefined,
            channel: opts.channel as string | undefined,
            agent: opts.agent as string | undefined,
            limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : 50,
          },
          defaultRuntime,
        );
      });
    });

  notif
    .command("read")
    .description("Mark notifications as read")
    .option("--id <id>", "Mark a specific notification as read")
    .option("--all", "Mark all notifications as read", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await notificationsReadCommand(
          {
            id: opts.id as string | undefined,
            all: Boolean(opts.all),
          },
          defaultRuntime,
        );
      });
    });

  notif
    .command("clear")
    .description("Clear all notifications")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await notificationsClearCommand(defaultRuntime);
      });
    });

  notif
    .command("prefs")
    .description("View or update notification preferences")
    .option("--json", "Output as JSON", false)
    .option("--enabled <bool>", "Enable/disable notifications (true/false)")
    .option("--min-priority <level>", "Minimum priority to deliver (low, normal, high, urgent)")
    .option("--group-by <key>", "Group notifications by: channel, agent, category")
    .option("--quiet-start <time>", "Quiet hours start (HH:MM)")
    .option("--quiet-end <time>", "Quiet hours end (HH:MM)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot notifications prefs", "Show current preferences."],
          ["moltbot notifications prefs --enabled true", "Enable notifications."],
          ["moltbot notifications prefs --min-priority high", "Only deliver high/urgent."],
          ['moltbot notifications prefs --quiet-start "22:00" --quiet-end "08:00"', "Set quiet hours."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await notificationsPrefsCommand(
          {
            json: Boolean(opts.json),
            enabled: opts.enabled as string | undefined,
            minPriority: opts.minPriority as string | undefined,
            groupBy: opts.groupBy as string | undefined,
            quietStart: opts.quietStart as string | undefined,
            quietEnd: opts.quietEnd as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
