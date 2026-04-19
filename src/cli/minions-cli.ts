import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function run(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

export function registerMinionsCli(program: Command) {
  const minions = program
    .command("minions")
    .description("Inspect and manage the minions job queue (durable subagent substrate)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw minions list", "Show recent jobs across all queues."],
          ["openclaw minions list --status active", "Show currently running jobs."],
          ["openclaw minions stats", "Queue health dashboard."],
          ["openclaw minions get 42", "Show full details for job #42."],
          ["openclaw minions cancel 42", "Cancel job #42 and all descendants."],
          ["openclaw minions smoke", "Quick smoke test: submit + complete a job."],
        ])}\n`,
    );

  minions
    .command("list")
    .description("List jobs in the queue")
    .option("--status <status>", "Filter by status (waiting, active, completed, failed, dead, cancelled)")
    .option("--queue <queue>", "Filter by queue name")
    .option("--name <name>", "Filter by job name")
    .option("--limit <n>", "Max results", "20")
    .action((opts) =>
      run(async () => {
        const { MinionQueue } = await import("../minions/queue.js");
        const { MinionStore } = await import("../minions/store.js");
        const store = MinionStore.openDefault();
        const queue = new MinionQueue(store);
        const jobs = queue.getJobs({
          status: opts.status,
          queue: opts.queue,
          name: opts.name,
          limit: Number.parseInt(opts.limit, 10),
        });
        if (jobs.length === 0) {
          defaultRuntime.log(theme.muted("No jobs found."));
          return;
        }
        for (const job of jobs) {
          const age = formatAge(job.createdAt);
          const statusColor = statusToColor(job.status);
          defaultRuntime.log(
            `${theme.muted(`#${job.id}`)} ${statusColor(job.status.padEnd(17))} ${job.name} ${theme.muted(age)}`,
          );
        }
        defaultRuntime.log(theme.muted(`\n${jobs.length} job(s) shown.`));
      }),
    );

  minions
    .command("get <id>")
    .description("Show full details for a job")
    .action((idStr) =>
      run(async () => {
        const { MinionQueue } = await import("../minions/queue.js");
        const { MinionStore } = await import("../minions/store.js");
        const store = MinionStore.openDefault();
        const queue = new MinionQueue(store);
        const id = Number.parseInt(idStr, 10);
        const job = queue.getJob(id);
        if (!job) {
          defaultRuntime.error(`Job #${id} not found.`);
          return;
        }
        defaultRuntime.log(JSON.stringify(job, null, 2));
      }),
    );

  minions
    .command("cancel <id>")
    .description("Cancel a job and all its descendants")
    .action((idStr) =>
      run(async () => {
        const { MinionQueue } = await import("../minions/queue.js");
        const { MinionStore } = await import("../minions/store.js");
        const store = MinionStore.openDefault();
        const queue = new MinionQueue(store);
        const id = Number.parseInt(idStr, 10);
        const result = queue.cancelJob(id);
        if (!result) {
          defaultRuntime.error(`Job #${id} not found or already terminal.`);
          return;
        }
        defaultRuntime.log(`Cancelled job #${id} (and all descendants).`);
      }),
    );

  minions
    .command("stats")
    .description("Show queue health dashboard")
    .action(() =>
      run(async () => {
        const { MinionQueue } = await import("../minions/queue.js");
        const { MinionStore } = await import("../minions/store.js");
        const store = MinionStore.openDefault();
        const queue = new MinionQueue(store);
        const stats = queue.getStats();
        defaultRuntime.log(theme.heading("Queue Health"));
        defaultRuntime.log(
          `  Waiting: ${stats.queueHealth.waiting}  Active: ${stats.queueHealth.active}  Stalled: ${stats.queueHealth.stalled}`,
        );
        defaultRuntime.log(theme.heading("\nBy Status"));
        for (const [status, count] of Object.entries(stats.byStatus).toSorted(([, a], [, b]) => b - a)) {
          defaultRuntime.log(`  ${status.padEnd(20)} ${count}`);
        }
      }),
    );

  minions
    .command("retry <id>")
    .description("Re-queue a failed or dead job")
    .action((idStr) =>
      run(async () => {
        const { MinionQueue } = await import("../minions/queue.js");
        const { MinionStore } = await import("../minions/store.js");
        const store = MinionStore.openDefault();
        const queue = new MinionQueue(store);
        const id = Number.parseInt(idStr, 10);
        const result = queue.retryJob(id);
        if (!result) {
          defaultRuntime.error(`Job #${id} not found or not in a retryable state.`);
          return;
        }
        defaultRuntime.log(`Re-queued job #${id}.`);
      }),
    );

  minions
    .command("prune")
    .description("Remove old completed/dead/cancelled jobs")
    .option("--days <n>", "Remove jobs older than N days", "30")
    .action((opts) =>
      run(async () => {
        const { MinionQueue } = await import("../minions/queue.js");
        const { MinionStore } = await import("../minions/store.js");
        const store = MinionStore.openDefault();
        const queue = new MinionQueue(store);
        const days = Number.parseInt(opts.days, 10);
        const count = queue.prune({ olderThanMs: days * 86400000 });
        defaultRuntime.log(`Pruned ${count} job(s) older than ${days} days.`);
      }),
    );

  minions
    .command("smoke")
    .description("Quick smoke test: submit a job, complete it, verify")
    .action(() =>
      run(async () => {
        const { MinionQueue } = await import("../minions/queue.js");
        const { MinionStore } = await import("../minions/store.js");
        const store = MinionStore.openDefault();
        const queue = new MinionQueue(store);

        const start = Date.now();
        const job = queue.add("smoke-test", { ts: start }, { idempotencyKey: `smoke-${start}` });
        const claimed = queue.claim("smoke-worker", 30000, "default", ["smoke-test"]);
        if (!claimed) {
          defaultRuntime.error("Smoke test failed: could not claim job.");
          return;
        }
        const completed = queue.completeJob(claimed.id, "smoke-worker", claimed.attemptsMade, {
          smoke: true,
        });
        if (!completed) {
          defaultRuntime.error("Smoke test failed: could not complete job.");
          return;
        }
        const elapsed = Date.now() - start;
        defaultRuntime.log(
          `${theme.success("Smoke test passed")} in ${elapsed}ms (job #${job.id} → completed).`,
        );
      }),
    );
}

function formatAge(createdAt: number): string {
  const ms = Date.now() - createdAt;
  if (ms < 60000) {
    return `${Math.floor(ms / 1000)}s ago`;
  }
  if (ms < 3600000) {
    return `${Math.floor(ms / 60000)}m ago`;
  }
  if (ms < 86400000) {
    return `${Math.floor(ms / 3600000)}h ago`;
  }
  return `${Math.floor(ms / 86400000)}d ago`;
}

function statusToColor(status: string) {
  switch (status) {
    case "active":
      return theme.info;
    case "completed":
      return theme.success;
    case "failed":
    case "dead":
      return theme.error;
    case "cancelled":
      return theme.muted;
    default:
      return theme.muted;
  }
}
