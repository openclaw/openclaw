import type { Command } from "commander";
import { danger } from "../globals.js";
import {
  operatorBootstrap,
  operatorNextTicket,
  operatorPauseAll,
  operatorPulse,
  operatorRecommendNext,
  operatorRequestReview,
  operatorResumeAll,
  operatorSpotCheck,
  operatorStartTicket,
  operatorStatus,
  operatorStopAll,
} from "../operator-harness/harness.js";
import { defaultRuntime } from "../runtime.js";

type OperatorParentOptions = {
  config?: string;
  json?: boolean;
};

export function registerOperatorCli(program: Command) {
  const operator = program
    .command("operator")
    .description("Operate the OpenClaw + Paperclip supervised delivery harness")
    .option("--config <path>", "Harness config file path")
    .option("--json", "Output JSON", false)
    .action(() => {
      operator.outputHelp();
      defaultRuntime.exit(1);
    });

  const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as OperatorParentOptions;

  operator
    .command("bootstrap")
    .description("Provision the local Paperclip harness company, project, and agents")
    .action(async (_opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorBootstrap(opts.config, defaultRuntime));
    });

  operator
    .command("pulse")
    .description("Show compact operator state for heartbeat and automation loops")
    .action(async (_opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorPulse(opts.config, defaultRuntime, opts.json));
    });

  operator
    .command("status")
    .description(
      "Show ready work, active work, blocked work, pending reviews, and missing evidence",
    )
    .action(async (_opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorStatus(opts.config, defaultRuntime, opts.json));
    });

  operator
    .command("start-ticket")
    .description("Create or refresh the Paperclip execution issue and wake the builder")
    .argument("<ticketKey>", "Linear ticket key")
    .action(async (ticketKey: string, _opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorStartTicket(opts.config, ticketKey, defaultRuntime));
    });

  operator
    .command("next-ticket")
    .description("Select the next eligible ticket using queue rules and dispatch it")
    .action(async (_opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorNextTicket(opts.config, defaultRuntime));
    });

  operator
    .command("recommend-next")
    .description("Show the next eligible ticket without dispatching it")
    .action(async (_opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorRecommendNext(opts.config, defaultRuntime, opts.json));
    });

  operator
    .command("request-review")
    .description("Wake the required reviewers for the specified ticket")
    .argument("<ticketKey>", "Linear ticket key")
    .action(async (ticketKey: string, _opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorRequestReview(opts.config, ticketKey, defaultRuntime));
    });

  operator
    .command("spot-check")
    .description("Boot the local app, drive the browser flow, and attach operator evidence")
    .argument("<ticketKey>", "Linear ticket key")
    .action(async (ticketKey: string, _opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorSpotCheck(opts.config, ticketKey, defaultRuntime));
    });

  operator
    .command("pause-all")
    .description("Pause Paperclip agents and prevent new work from starting")
    .action(async (_opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorPauseAll(opts.config, defaultRuntime));
    });

  operator
    .command("resume-all")
    .description("Resume paused Paperclip agents")
    .action(async (_opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorResumeAll(opts.config, defaultRuntime));
    });

  operator
    .command("stop-all")
    .description("Pause harness agents and cancel live runs")
    .action(async (_opts, cmd) => {
      const opts = parentOpts(cmd);
      await runOperatorAction(() => operatorStopAll(opts.config, defaultRuntime));
    });
}

async function runOperatorAction(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    defaultRuntime.error(danger(String(error instanceof Error ? error.message : error)));
    defaultRuntime.exit(1);
  }
}
