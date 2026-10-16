import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { createSessionListWorkerKernel } from "./session-list-worker-kernel.js";
import type { SessionListWorkerCommand, SessionListWorkerReply } from "./session-list-worker.js";
import { renderPreparedSessionRow } from "./session-row-render.js";

let kernel: ReturnType<typeof createSessionListWorkerKernel> | undefined;
serveWorkerTasks<SessionListWorkerReply>(async (input) => {
  // SAFETY: The projection-owned pool is the only sender on this private transport.
  const command = input as SessionListWorkerCommand;
  if (command.kind === "render") {
    const context = {
      ...command.context,
      subagentRuns: buildSubagentRunReadIndexFromRuns(command.context.subagentRuns).atTime(
        command.now,
      ),
    };
    return {
      kind: "rows",
      rows: command.rows.map((rowInput) => {
        const row = renderPreparedSessionRow(rowInput, { ...context, now: command.now });
        return { row, encoded: JSON.stringify(row) };
      }),
    };
  }
  const { update, request } = command;
  if (!kernel && !update.reset) {
    return { kind: "reset" };
  }
  kernel ??= createSessionListWorkerKernel();
  kernel.apply(update);
  return { kind: "page", page: kernel.select(request) };
});
