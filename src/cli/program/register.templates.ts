import type { Command } from "commander";
import {
  templatesAddCommand,
  templatesListCommand,
  templatesRemoveCommand,
  templatesShowCommand,
  templatesUpdateCommand,
} from "../../commands/templates.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerTemplatesCommands(program: Command) {
  const templates = program
    .command("templates")
    .description("Manage response templates and quick replies");

  templates
    .command("list")
    .description("List all response templates")
    .option("--json", "Output as JSON", false)
    .option("--agent <id>", "Filter templates available to a specific agent")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot templates list", "List all templates."],
          ["moltbot templates list --json", "JSON output."],
          ["moltbot templates list --agent pi", "Templates available to the pi agent."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await templatesListCommand(
          {
            json: Boolean(opts.json),
            agent: opts.agent as string | undefined,
          },
          defaultRuntime,
        );
      });
    });

  templates
    .command("add")
    .description("Add a new response template")
    .requiredOption("--id <id>", "Unique template identifier")
    .requiredOption("--name <name>", "Human-readable template name")
    .requiredOption("--content <text>", "Template content (supports {variable} placeholders)")
    .option("--agents <ids>", "Comma-separated agent ids this template applies to")
    .option(
      "--channels <overrides>",
      "Channel-specific content overrides (format: channel:content,...)",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            'moltbot templates add --id greeting --name "Greeting" --content "Hello {senderName}! How can I help you today?"',
            "Add a greeting template.",
          ],
          [
            'moltbot templates add --id away --name "Away" --content "I am currently away. I will respond when available." --agents pi',
            "Agent-specific template.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await templatesAddCommand(
          {
            id: String(opts.id),
            name: String(opts.name),
            content: String(opts.content),
            agents: opts.agents as string | undefined,
            channels: opts.channels as string | undefined,
          },
          defaultRuntime,
        );
      });
    });

  templates
    .command("remove")
    .description("Remove a response template")
    .argument("<id>", "Template id to remove")
    .action(async (id) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await templatesRemoveCommand({ id: String(id) }, defaultRuntime);
      });
    });

  templates
    .command("show")
    .description("Show a template with optional variable expansion")
    .argument("<id>", "Template id or name")
    .option("--channel <name>", "Resolve channel-specific content")
    .option("--expand", "Expand variables in the template", false)
    .option("--vars <pairs>", "Variable values for expansion (format: key=value,...)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot templates show greeting", "Show the greeting template."],
          [
            'moltbot templates show greeting --expand --vars "senderName=Alice"',
            "Expand variables.",
          ],
          ["moltbot templates show greeting --channel telegram", "Show Telegram-specific content."],
        ])}`,
    )
    .action(async (id, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await templatesShowCommand(
          {
            id: String(id),
            channel: opts.channel as string | undefined,
            expand: Boolean(opts.expand),
            vars: opts.vars as string | undefined,
          },
          defaultRuntime,
        );
      });
    });

  templates
    .command("update")
    .description("Update an existing response template")
    .argument("<id>", "Template id to update")
    .option("--name <name>", "New name")
    .option("--content <text>", "New content")
    .option("--agents <ids>", "New comma-separated agent ids")
    .action(async (id, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await templatesUpdateCommand(
          {
            id: String(id),
            name: opts.name as string | undefined,
            content: opts.content as string | undefined,
            agents: opts.agents as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
