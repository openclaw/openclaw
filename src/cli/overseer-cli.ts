import type { Command } from "commander";

import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

function parseList(input?: string | string[]): string[] | undefined {
  if (!input) return undefined;
  const parts = Array.isArray(input) ? input : [input];
  const out = parts
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

export function registerOverseerCli(program: Command) {
  const overseer = program.command("overseer").description("Manage Overseer supervisor");

  addGatewayClientOptions(
    overseer
      .command("status")
      .description("Show overseer status summary")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("overseer.status", opts, {});
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  const goal = overseer.command("goal").description("Manage overseer goals");

  addGatewayClientOptions(
    goal
      .command("create")
      .description("Create a goal and (optionally) generate a plan")
      .requiredOption("--title <title>", "Goal title")
      .requiredOption("--problem <text>", "Problem statement")
      .option("--success <text>", "Success criteria (comma-separated)")
      .option("--constraint <text>", "Constraints (comma-separated)")
      .option("--non-goal <text>", "Non-goals (comma-separated)")
      .option("--tag <text>", "Tags (comma-separated)")
      .option("--priority <level>", "Priority: low|normal|high|urgent", "normal")
      .option("--from-session <key>", "Source session key")
      .option("--owner <id>", "Owner identifier")
      .option("--repo-context <text>", "Repo context snapshot")
      .option("--no-plan", "Skip plan generation", false)
      .action(async (opts) => {
        try {
          const payload = {
            title: String(opts.title),
            problemStatement: String(opts.problem),
            successCriteria: parseList(opts.success),
            constraints: parseList(opts.constraint),
            nonGoals: parseList(opts["non-goal"] ?? opts.nonGoal),
            tags: parseList(opts.tag),
            priority: String(opts.priority),
            fromSession: opts.fromSession ? String(opts.fromSession) : undefined,
            owner: opts.owner ? String(opts.owner) : undefined,
            repoContextSnapshot: opts.repoContext ? String(opts.repoContext) : undefined,
            generatePlan: opts.plan !== false,
          };
          const res = await callGatewayFromCli("overseer.goal.create", opts, payload);
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    goal
      .command("pause")
      .description("Pause a goal")
      .argument("<goalId>", "Goal id")
      .action(async (goalId, opts) => {
        try {
          const res = await callGatewayFromCli("overseer.goal.pause", opts, { goalId });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    goal
      .command("resume")
      .description("Resume a goal")
      .argument("<goalId>", "Goal id")
      .action(async (goalId, opts) => {
        try {
          const res = await callGatewayFromCli("overseer.goal.resume", opts, { goalId });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  const work = overseer.command("work").description("Update work nodes");

  addGatewayClientOptions(
    work
      .command("done")
      .description("Mark work node as done")
      .argument("<workNodeId>", "Work node id")
      .requiredOption("--goal <goalId>", "Goal id")
      .option("--summary <text>", "Crystallization summary")
      .action(async (workNodeId, opts) => {
        try {
          const res = await callGatewayFromCli("overseer.work.update", opts, {
            goalId: String(opts.goal),
            workNodeId,
            status: "done",
            summary: opts.summary ? String(opts.summary) : undefined,
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    work
      .command("block")
      .description("Block a work node with a reason")
      .argument("<workNodeId>", "Work node id")
      .requiredOption("--goal <goalId>", "Goal id")
      .requiredOption("--reason <text>", "Blocker reason")
      .action(async (workNodeId, opts) => {
        try {
          const res = await callGatewayFromCli("overseer.work.update", opts, {
            goalId: String(opts.goal),
            workNodeId,
            status: "blocked",
            blockedReason: String(opts.reason),
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    overseer
      .command("tick")
      .description("Run overseer tick now")
      .option("--reason <text>", "Reason for tick")
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("overseer.tick", opts, {
            reason: opts.reason ? String(opts.reason) : undefined,
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
