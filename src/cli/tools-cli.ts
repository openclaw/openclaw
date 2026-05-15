import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  executeToolPlan,
  type ExecutePlanInput,
  type ExecutePlanToolInvokeResult,
} from "../tools/execute-plan.js";
import { resolveUserPath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";

type ToolsExecutePlanOpts = GatewayRpcOpts & {
  file?: string;
  continueOnError?: boolean;
  sessionKey?: string;
  agentId?: string;
  confirm?: boolean;
  json?: boolean;
};

async function readPlanFile(filePath: string): Promise<ExecutePlanInput> {
  const raw = await readFile(resolveUserPath(filePath), "utf8");
  return JSON.parse(raw) as ExecutePlanInput;
}

function resolvePlanFile(argumentFile: string | undefined, opts: ToolsExecutePlanOpts): string {
  const file = normalizeOptionalString(argumentFile) ?? normalizeOptionalString(opts.file);
  if (!file) {
    throw new Error(
      `plan file required. Example: ${formatCliCommand("openclaw tools execute-plan plan.json --json")}.`,
    );
  }
  return file;
}

function renderTextSummary(result: Awaited<ReturnType<typeof executeToolPlan>>): void {
  for (const step of result.steps) {
    const suffix = step.error ? ` - ${step.error.message}` : "";
    defaultRuntime.log(`${step.index + 1}. ${step.action}: ${step.status}${suffix}`);
  }
  if (result.ok) {
    defaultRuntime.log("plan completed");
    return;
  }
  defaultRuntime.log(`plan stopped: ${result.stopReason ?? "tool_error"}`);
}

async function runExecutePlan(argumentFile: string | undefined, opts: ToolsExecutePlanOpts) {
  const input = await readPlanFile(resolvePlanFile(argumentFile, opts));
  const sessionKey = normalizeOptionalString(opts.sessionKey);
  const agentId = normalizeOptionalString(opts.agentId);

  const result = await executeToolPlan(input, {
    continueOnError: Boolean(opts.continueOnError),
    invoke: async (step): Promise<ExecutePlanToolInvokeResult> => {
      const response = await callGatewayFromCli(
        "tools.invoke",
        opts,
        {
          name: step.action,
          args: step.args,
          ...(sessionKey ? { sessionKey } : {}),
          ...(agentId ? { agentId } : {}),
          ...(opts.confirm ? { confirm: true } : {}),
          idempotencyKey: `cli-execute-plan-${Date.now()}-${step.index}`,
        },
        { expectFinal: false },
      );
      return response as ExecutePlanToolInvokeResult;
    },
  });

  if (opts.json) {
    defaultRuntime.writeJson(result);
  } else {
    renderTextSummary(result);
  }

  if (!result.ok) {
    defaultRuntime.exit(1);
  }
}

export function registerToolsCli(program: Command) {
  const tools = program.command("tools").description("Invoke Gateway tools and execute tool plans");

  addGatewayClientOptions(
    tools
      .command("execute-plan [file]")
      .description("Execute a JSON tool plan through the Gateway tools.invoke boundary")
      .option("--file <path>", "Path to a JSON plan file")
      .option("--continue-on-error", "Continue after a blocked or failed tool", false)
      .option(
        "--session-key <sessionKey>",
        "Target a specific session for tool policy/context resolution",
      )
      .option("--agent-id <agentId>", "Target a specific agent")
      .option(
        "--confirm",
        "Request approval instead of only reporting approval requirements",
        false,
      )
      .option("--json", "Output JSON", false),
  ).action(async (file: string | undefined, opts: ToolsExecutePlanOpts) => {
    try {
      await runExecutePlan(file, opts);
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });
}
