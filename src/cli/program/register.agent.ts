import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { hasExplicitOptions } from "../command-options.js";
import { formatDocsHelp, formatHelpExamples } from "../help-format.js";
import { collectOption } from "./helpers.js";

async function runAgentsCommandAction(action: () => Promise<void>): Promise<void> {
  const [{ defaultRuntime }, { runCommandWithRuntime }] = await Promise.all([
    import("../../runtime.js"),
    import("../cli-utils.js"),
  ]);
  await runCommandWithRuntime(defaultRuntime, action);
}

export function registerAgentsCommands(program: Command): void {
  const agents = program
    .command("agents")
    .description("Manage isolated agents (workspaces + auth + routing)")
    .addHelpText("after", () => formatDocsHelp("/cli/agents"));

  agents
    .command("list")
    .description("List configured agents")
    .option("--json", "Output JSON instead of text", false)
    .option("--bindings", "Include routing bindings", false)
    .option("--tree", "Render agent creation hierarchy", false)
    .action(async (opts): Promise<void> => {
      await runAgentsCommandAction(async () => {
        const { agentsListCommand } = await import("../../commands/agents.commands.list.js");
        await agentsListCommand(opts);
      });
    });

  agents
    .command("bindings")
    .description("List routing bindings")
    .option("--agent <id>", "Filter by agent id")
    .option("--json", "Output JSON instead of text", false)
    .action(async (opts): Promise<void> => {
      await runAgentsCommandAction(async () => {
        const { agentsBindingsCommand } = await import("../../commands/agents.commands.bind.js");
        await agentsBindingsCommand(opts);
      });
    });

  for (const operation of ["bind", "unbind"] as const) {
    const command = agents
      .command(operation)
      .description(`${operation === "bind" ? "Add" : "Remove"} routing bindings for an agent`)
      .option("--agent <id>", "Agent id (defaults to current default agent)")
      .option(
        "--bind <channel[:accountId]>",
        operation === "bind"
          ? "Binding to add (repeatable). If omitted, accountId is resolved by channel defaults/hooks."
          : "Binding to remove (repeatable)",
        collectOption,
        [],
      );
    if (operation === "unbind") {
      command.option("--all", "Remove all bindings for this agent", false);
    }
    command.option("--json", "Output JSON summary", false).action(async (opts): Promise<void> => {
      await runAgentsCommandAction(async () => {
        const { agentsUpdateBindingsCommand } =
          await import("../../commands/agents.commands.bind.js");
        await agentsUpdateBindingsCommand(operation, opts);
      });
    });
  }

  agents
    .command("add [name]")
    .description("Add a new isolated agent")
    .option("--workspace <dir>", "Workspace directory for the new agent")
    .option("--role <role>", "Seed a role: coordinator, researcher, writer, reviewer")
    .option("--model <id>", "Model id for this agent")
    .option("--agent-dir <dir>", "Agent state directory for this agent")
    .option("--bind <channel[:accountId]>", "Route channel binding (repeatable)", collectOption, [])
    .option(
      "--non-interactive",
      "Disable prompts; requires --workspace unless --role is set",
      false,
    )
    .option("--json", "Output JSON summary", false)
    .action(async (name, opts, command): Promise<void> => {
      await runAgentsCommandAction(async () => {
        const hasAutomationFlags = hasExplicitOptions(command, [
          "workspace",
          "model",
          "agentDir",
          "bind",
          "nonInteractive",
        ]);
        const { agentsAddCommand } = await import("../../commands/agents.commands.add.js");
        await agentsAddCommand({ ...opts, name }, { hasAutomationFlags });
      });
    });

  agents
    .command("team")
    .description("Create a coordinated team of agents")
    .command("create")
    .description("Create a coordinator and specialists from a bundled preset")
    .option("--preset <name>", "Team preset (team)", "team")
    .option("--coordinator <id>", "Coordinator agent id", "coordinator")
    .option("--prefix <p>", "Prefix every team agent id with <p>-")
    .option("--workspace-root <dir>", "Parent directory for separate team workspaces")
    .option("--non-interactive", "Disable prompts", false)
    .option("--json", "Output JSON summary", false)
    .action(async (opts): Promise<void> => {
      await runAgentsCommandAction(async () => {
        const { agentsTeamCreateCommand } = await import("../../commands/agents.commands.team.js");
        await agentsTeamCreateCommand(opts);
      });
    });

  agents
    .command("set-identity")
    .description("Update an agent identity (name/theme/emoji/avatar)")
    .option("--agent <id>", "Agent id to update")
    .option(
      "--workspace <dir>",
      "Locate the agent and IDENTITY.md; does not change the stored workspace",
    )
    .option("--identity-file <path>", "Explicit IDENTITY.md path to read")
    .option("--from-identity", "Read values from IDENTITY.md", false)
    .option("--name <name>", "Identity name")
    .option("--theme <theme>", "Identity theme")
    .option("--emoji <emoji>", "Identity emoji")
    .option("--avatar <value>", "Identity avatar (workspace path, http(s) URL, or data URI)")
    .option("--json", "Output JSON summary", false)
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  ['openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞"', "Set name + emoji."],
  ["openclaw agents set-identity --agent main --avatar avatars/openclaw.png", "Set avatar path."],
  [
    "openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity",
    "Load from IDENTITY.md.",
  ],
  [
    "openclaw agents set-identity --identity-file ~/.openclaw/workspace/IDENTITY.md --agent main",
    "Use a specific IDENTITY.md.",
  ],
])}
`,
    )
    .action(async (opts): Promise<void> => {
      await runAgentsCommandAction(async () => {
        const { agentsSetIdentityCommand } =
          await import("../../commands/agents.commands.identity.js");
        await agentsSetIdentityCommand(opts);
      });
    });

  agents
    .command("delete <id>")
    .description("Delete an agent and prune workspace/state")
    .option("--force", "Skip confirmation", false)
    .option("--json", "Output JSON summary", false)
    .action(async (id, opts): Promise<void> => {
      await runAgentsCommandAction(async () => {
        const { agentsDeleteCommand } = await import("../../commands/agents.commands.delete.js");
        await agentsDeleteCommand({ ...opts, id });
      });
    });

  agents
    .command("tools <sessionKey>")
    .description("Explain the effective tool set for one session")
    .option("--agent <id>", "Agent id that owns the session")
    .option("--json", "Output JSON instead of text", false)
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "RPC timeout in milliseconds")
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  [
    'openclaw agents tools "agent:main:main"',
    "Why each tool is allowed, excluded, or unavailable for a session.",
  ],
  [
    'openclaw agents tools "agent:work:main" --agent work --json',
    "One session's tool-access diagnostics as JSON.",
  ],
])}

${theme.muted(
  "Backed by the tools.effective gateway RPC; reasons carry the profile, deny, allowlist, session, or runtime rule that decided each tool.",
)}`,
    )
    .action(async (sessionKey: string, opts): Promise<void> => {
      await runAgentsCommandAction(async () => {
        const { agentsToolsCommand } = await import("../../commands/agents-tools.js");
        await agentsToolsCommand({
          sessionKey,
          agent: opts.agent as string | undefined, // SAFETY: Commander parses --agent as a string.
          timeout: opts.timeout as string | undefined, // SAFETY: Commander parses --timeout as a string.
          url: opts.url as string | undefined, // SAFETY: Commander parses transport options as strings.
          token: opts.token as string | undefined, // SAFETY: Commander parses transport options as strings.
          password: opts.password as string | undefined, // SAFETY: Commander parses transport options as strings.
          json: Boolean(opts.json),
        });
      });
    });

  agents.action(async (): Promise<void> => {
    await runAgentsCommandAction(async () => {
      const { agentsListCommand } = await import("../../commands/agents.commands.list.js");
      await agentsListCommand({});
    });
  });
}
