import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { getDefaultWorkQueueStore } from "../work-queue/index.js";

export function registerWorkQueueCli(program: Command) {
  const workQueue = program.command("work-queue").description("Inspect work queues");

  workQueue
    .command("list")
    .description("List work queues")
    .option("--agent <agentId>", "Filter by agent ID")
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const store = await getDefaultWorkQueueStore();
      const queues = await store.listQueues({ agentId: opts.agent });
      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ queues }, null, 2));
        return;
      }
      if (queues.length === 0) {
        defaultRuntime.log(theme.muted("No work queues found."));
        return;
      }
      const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
      defaultRuntime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "ID", header: "ID", minWidth: 12 },
            { key: "Agent", header: "Agent", minWidth: 10 },
            { key: "Name", header: "Name", minWidth: 16, flex: true },
            { key: "Concurrency", header: "Concurrency", minWidth: 11 },
            { key: "Priority", header: "Priority", minWidth: 8 },
            { key: "Updated", header: "Updated", minWidth: 18 },
          ],
          rows: queues.map((queue) => ({
            ID: queue.id,
            Agent: queue.agentId,
            Name: queue.name,
            Concurrency: String(queue.concurrencyLimit),
            Priority: queue.defaultPriority,
            Updated: queue.updatedAt,
          })),
        }).trimEnd(),
      );
    });

  workQueue
    .command("stats")
    .description("Show work queue stats")
    .option("--queue <queueId>", "Queue ID")
    .option("--agent <agentId>", "Agent ID")
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const store = await getDefaultWorkQueueStore();
      const cfg = loadConfig();
      const agentId = opts.agent ?? resolveDefaultAgentId(cfg);
      const queue = opts.queue
        ? await store.getQueue(opts.queue)
        : await store.getQueueByAgentId(agentId);
      if (!queue) {
        throw new Error("Queue not found");
      }
      const stats = await store.getQueueStats(queue.id);
      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ queue, stats }, null, 2));
        return;
      }
      const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
      defaultRuntime.log(`${theme.heading("Work queue stats")} ${theme.muted(queue.id)}`);
      defaultRuntime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "Status", header: "Status", minWidth: 10 },
            { key: "Count", header: "Count", minWidth: 6 },
          ],
          rows: [
            { Status: "pending", Count: String(stats.pending) },
            { Status: "in_progress", Count: String(stats.inProgress) },
            { Status: "blocked", Count: String(stats.blocked) },
            { Status: "completed", Count: String(stats.completed) },
            { Status: "failed", Count: String(stats.failed) },
            { Status: "cancelled", Count: String(stats.cancelled) },
            { Status: "total", Count: String(stats.total) },
          ],
        }).trimEnd(),
      );
    });
}
