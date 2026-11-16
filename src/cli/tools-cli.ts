import { InvalidArgumentError, type Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  resolveGatewayRpcOptionsWithLocalPort,
  type GatewayRpcOpts,
} from "./gateway-rpc.js";
import { formatDocsHelp } from "./help-format.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type ToolUsageOptions = GatewayRpcOpts & {
  agent?: string;
  since?: number;
  dryRun?: boolean;
  session?: string;
  limit?: number;
};

function boundedInteger(value: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new InvalidArgumentError(`Expected an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

export function registerToolsCli(program: Command): void {
  const tools = program
    .command("tools")
    .description("Inspect and manage learned tool usage")
    .addHelpText("after", () =>
      formatDocsHelp("/concepts/experimental-features#usage-ranked-tool-index"),
    );
  const usage = tools
    .command("usage")
    .description("Manage the usage-ranked tool index (admin only)");

  for (const action of ["status", "import", "reset"] as const) {
    const command = addGatewayClientOptions(
      usage
        .command(action)
        .description(
          action === "status"
            ? "Show current decayed scores and the last import"
            : action === "import"
              ? "Import uncounted historical usage from retained transcripts"
              : "Clear learned usage and discard pending counts",
        )
        .option("--agent <id>", "Agent ID", "main")
        .option("--json", "Output JSON", false),
      { timeoutMs: action === "import" ? 300_000 : 30_000 },
    );
    if (action === "import") {
      command
        .option(
          "--since <days>",
          "Days of retained history (1–90)",
          (value) => boundedInteger(value, 90),
          90,
        )
        .option("--dry-run", "Preview without changing learned usage", false);
    } else if (action === "status") {
      command
        .option("--session <key>", "Also inspect this session's frozen ranking snapshot")
        .option(
          "--limit <count>",
          "Number of top tools (1–100)",
          (value) => boundedInteger(value, 100),
          20,
        );
    }
    command.action(async (options: ToolUsageOptions, cmd: Command) => {
      const signal = action === "status" ? getAsyncWorkSignal() : undefined;
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await callGatewayFromCli(
          `toolUsage.${action}`,
          resolveGatewayRpcOptionsWithLocalPort(options, cmd),
          {
            agentId: options.agent,
            ...(action === "import"
              ? { sinceDays: options.since, dryRun: options.dryRun }
              : action === "status"
                ? {
                    limit: options.limit,
                    ...(options.session ? { sessionKey: options.session } : {}),
                  }
                : {}),
          },
          { scopes: ["operator.admin"], ...(signal ? { signal } : {}) },
        ).catch((error: unknown) => {
          if (!signal?.aborted) {
            throw error;
          }
        });
        if (signal?.aborted) {
          return;
        }
        if (options.json) {
          defaultRuntime.writeJson(result, 2);
          return;
        }
        defaultRuntime.log(JSON.stringify(result, null, 2));
      });
    });
  }
  applyParentDefaultHelpAction(usage);
  applyParentDefaultHelpAction(tools);
}
