import type { Command } from "commander";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

export function registerTasksCli(program: Command) {
  const tasks = program
    .command("tasks")
    .description("Register tasks and notify session watchers")
    .action(() => {
      tasks.help({ error: true });
    });

  // tasks register
  addGatewayClientOptions(
    tasks
      .command("register")
      .description("Register or update a task")
      .requiredOption("--id <id>", "Task identifier")
      .option("--desc <description>", "Human-readable description")
      .option("--status <status>", "Initial status (e.g. running, done, failed)")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        const params: Record<string, unknown> = { taskId: opts.id };
        if (opts.desc) {
          params.description = opts.desc;
        }
        if (opts.status) {
          params.status = opts.status;
        }
        const res = await callGatewayFromCli("tasks.register", opts, params);
        console.log(JSON.stringify(res, null, 2));
      }),
  );

  // tasks watch
  addGatewayClientOptions(
    tasks
      .command("watch")
      .description("Subscribe a session to task events")
      .requiredOption("--id <id>", "Task identifier")
      .requiredOption("--session <sessionKey>", "Session key to notify")
      .option("--label <label>", "Optional human label for this watcher")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        const params: Record<string, unknown> = {
          taskId: opts.id,
          sessionKey: opts.session,
        };
        if (opts.label) {
          params.label = opts.label;
        }
        const res = await callGatewayFromCli("tasks.watch", opts, params);
        console.log(JSON.stringify(res, null, 2));
      }),
  );

  // tasks notify
  addGatewayClientOptions(
    tasks
      .command("notify")
      .description("Fire an event on a task and notify all watchers")
      .requiredOption("--id <id>", "Task identifier")
      .requiredOption("--event <event>", "Event name (e.g. completed, prCreated)")
      .requiredOption("--message <message>", "Human-readable notification message")
      .option("--status <status>", "Update task status at the same time")
      .option("--idempotency-key <key>", "Idempotency key (default: event name)")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        const params: Record<string, unknown> = {
          taskId: opts.id,
          event: opts.event,
          message: opts.message,
        };
        if (opts.status) {
          params.status = opts.status;
        }
        if (opts.idempotencyKey) {
          params.idempotencyKey = opts.idempotencyKey;
        }
        const res = await callGatewayFromCli("tasks.notify", opts, params);
        console.log(JSON.stringify(res, null, 2));
      }),
  );

  // tasks list
  addGatewayClientOptions(
    tasks
      .command("list")
      .description("List registered tasks")
      .option("--status <status>", "Filter by status")
      .option("--limit <n>", "Maximum number of tasks to return (default 50)", "50")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        const params: Record<string, unknown> = {};
        if (opts.status) {
          params.status = opts.status;
        }
        const limitRaw = Number.parseInt(String(opts.limit ?? "50"), 10);
        params.limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
        const res = await callGatewayFromCli("tasks.list", opts, params);
        console.log(JSON.stringify(res, null, 2));
      }),
  );

  // tasks remove
  addGatewayClientOptions(
    tasks
      .command("remove")
      .alias("rm")
      .description("Remove a task from the registry")
      .requiredOption("--id <id>", "Task identifier")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        const res = await callGatewayFromCli("tasks.remove", opts, { taskId: opts.id });
        console.log(JSON.stringify(res, null, 2));
      }),
  );
}
