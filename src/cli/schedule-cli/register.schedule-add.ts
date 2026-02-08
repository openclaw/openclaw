import type { Command } from "commander";
import { addOrUpdateJob } from "../../schedule/store.js";
import { theme } from "../../terminal/theme.js";

function parseEnvPairs(input: string[] | undefined): Record<string, string> | undefined {
  if (!input || input.length === 0) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const pair of input) {
    const idx = pair.indexOf("=");
    if (idx <= 0) {
      throw new Error(`invalid --env ${JSON.stringify(pair)} (expected KEY=VALUE)`);
    }
    const k = pair.slice(0, idx);
    const v = pair.slice(idx + 1);
    env[k] = v;
  }
  return env;
}

export function registerScheduleAddCommand(schedule: Command) {
  schedule
    .command("add")
    .description("Add or update a scheduled job")
    .argument("<id>", "Job id")
    .requiredOption("--cmd <cmd>", "Command to run (no shell)")
    .option(
      "--arg <arg>",
      "Command argument (repeatable)",
      (value, prev: string[]) => {
        prev.push(value);
        return prev;
      },
      [],
    )
    .option("--cwd <cwd>", "Working directory")
    .option("--description <text>", "Description")
    .option(
      "--env <KEY=VALUE>",
      "Environment variable override (repeatable)",
      (value, prev: string[]) => {
        prev.push(value);
        return prev;
      },
      [],
    )
    .action(
      async (
        id: string,
        opts: {
          cmd: string;
          arg: string[];
          cwd?: string;
          description?: string;
          env?: string[];
        },
      ) => {
        if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
          throw new Error(
            `invalid job id ${JSON.stringify(id)} (use letters, numbers, underscore, dot, dash)`,
          );
        }
        const env = parseEnvPairs(opts.env);
        const { job, created } = await addOrUpdateJob({
          id,
          description: opts.description,
          cmd: opts.cmd,
          args: opts.arg ?? [],
          cwd: opts.cwd,
          env,
        });
        process.stdout.write(
          `${created ? theme.success("Added") : theme.success("Updated")} job ${theme.bold(job.id)}\n`,
        );
      },
    );
}
