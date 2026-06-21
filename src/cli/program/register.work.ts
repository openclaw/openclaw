// Register Beads-backed durable work graph commands.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";
import { parseStrictPositiveIntOrUndefined } from "./helpers.js";

function parseLimit(limit: unknown): number | undefined | null {
  const parsed = parseStrictPositiveIntOrUndefined(limit);
  if (limit !== undefined && parsed === undefined) {
    defaultRuntime.error("--limit must be a positive integer, for example --limit 25.");
    defaultRuntime.exit(1);
    return null;
  }
  return parsed;
}

function addCommonListOptions(command: Command): Command {
  return command
    .option("--json", "Output JSON", false)
    .option("--limit <n>", "Limit displayed work items")
    .option("--label <name>", "Require a label (repeatable)", (value, previous: string[] = []) => [
      ...previous,
      value,
    ])
    .option(
      "--metadata <key=value>",
      "Require an exact metadata match (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    );
}

/** Register the Beads-backed durable work graph CLI group. */
export function registerWorkCommands(program: Command): void {
  const work = program
    .command("work")
    .description("Coordinate durable multi-step work with Beads")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw work ready", "Show unblocked work from the Beads graph."],
          [
            'openclaw work create "Fix gateway retry" --repo openclaw/openclaw --branch fix/retry --pr-url https://github.com/openclaw/openclaw/pull/123',
            "Create a durable work item with repo, branch, and PR metadata.",
          ],
          ["openclaw work claim bd-a1b2c3", "Claim a ready Beads item."],
          ["openclaw work close bd-a1b2c3 --reason merged", "Close finished work."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/work", "docs.openclaw.ai/cli/work")}\n`,
    );
  work.enablePositionalOptions();

  work
    .command("status")
    .description("Show Beads workspace status")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { workStatusCommand } = await import("../../commands/work.js");
        await workStatusCommand({ json: Boolean(opts.json) }, defaultRuntime);
      });
    });

  addCommonListOptions(work.command("ready").description("Show unblocked Beads work")).action(
    async (opts) => {
      const limit = parseLimit(opts.limit);
      if (limit === null) {
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { workReadyCommand } = await import("../../commands/work.js");
        await workReadyCommand(
          {
            json: Boolean(opts.json),
            limit,
            label: opts.label as string[] | undefined,
            metadata: opts.metadata as string[] | undefined,
          },
          defaultRuntime,
        );
      });
    },
  );

  addCommonListOptions(work.command("list").description("List Beads work"))
    .option("--status <name>", "Filter by Beads status")
    .option("--all", "Include closed work", false)
    .action(async (opts) => {
      const limit = parseLimit(opts.limit);
      if (limit === null) {
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { workListCommand } = await import("../../commands/work.js");
        await workListCommand(
          {
            json: Boolean(opts.json),
            limit,
            label: opts.label as string[] | undefined,
            metadata: opts.metadata as string[] | undefined,
            status: opts.status as string | undefined,
            all: Boolean(opts.all),
          },
          defaultRuntime,
        );
      });
    });

  work
    .command("create")
    .description("Create a Beads work item")
    .argument("<title>", "Work item title")
    .option("--json", "Output JSON", false)
    .option("--type <name>", "Beads type (task, bug, feature, epic, chore, decision)", "task")
    .option("--priority <value>", "Beads priority (P0-P4)", "P2")
    .option("--label <name>", "Add label (repeatable)", (value, previous: string[] = []) => [
      ...previous,
      value,
    ])
    .option(
      "--metadata <key=value>",
      "Set metadata (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .option("--repo <name>", "Repository metadata, for example openclaw/openclaw")
    .option("--branch <name>", "Branch metadata")
    .option("--pr-url <url>", "Pull request URL metadata and external ref")
    .option("--owner <name>", "Owner metadata")
    .option("--next-action <text>", "Next action metadata")
    .option("--description <text>", "Description")
    .option("--external-ref <value>", "External reference, for example gh-123")
    .option(
      "--depends-on <id>",
      "Add a blocking dependency (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--discovered-from <id>",
      "Add a discovered-from dependency (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .action(async (title, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { workCreateCommand } = await import("../../commands/work.js");
        await workCreateCommand(
          {
            title,
            json: Boolean(opts.json),
            type: opts.type as string | undefined,
            priority: opts.priority as string | undefined,
            label: opts.label as string[] | undefined,
            metadata: opts.metadata as string[] | undefined,
            repo: opts.repo as string | undefined,
            branch: opts.branch as string | undefined,
            prUrl: opts.prUrl as string | undefined,
            owner: opts.owner as string | undefined,
            nextAction: opts.nextAction as string | undefined,
            description: opts.description as string | undefined,
            externalRef: opts.externalRef as string | undefined,
            dependsOn: opts.dependsOn as string[] | undefined,
            discoveredFrom: opts.discoveredFrom as string[] | undefined,
          },
          defaultRuntime,
        );
      });
    });

  work
    .command("claim")
    .description("Claim a Beads work item")
    .argument("<id>", "Beads issue id")
    .option("--json", "Output JSON", false)
    .action(async (id, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { workClaimCommand } = await import("../../commands/work.js");
        await workClaimCommand({ id, json: Boolean(opts.json) }, defaultRuntime);
      });
    });

  work
    .command("show")
    .description("Show one Beads work item")
    .argument("<id>", "Beads issue id")
    .option("--json", "Output JSON", false)
    .action(async (id, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { workShowCommand } = await import("../../commands/work.js");
        await workShowCommand({ id, json: Boolean(opts.json) }, defaultRuntime);
      });
    });

  work
    .command("close")
    .description("Close a Beads work item")
    .argument("<id>", "Beads issue id")
    .option("--json", "Output JSON", false)
    .option("--reason <text>", "Close reason")
    .action(async (id, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { workCloseCommand } = await import("../../commands/work.js");
        await workCloseCommand(
          {
            id,
            json: Boolean(opts.json),
            reason: opts.reason as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
