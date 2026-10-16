import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { createSessionListWorkerKernel } from "./session-list-worker-kernel.js";
import type { SessionListWorkerCommand, SessionListWorkerReply } from "./session-list-worker.js";
import type { SessionListWorkerRow } from "./session-list-worker.types.js";

let kernel: ReturnType<typeof createSessionListWorkerKernel> | undefined;
serveWorkerTasks<SessionListWorkerReply>(async (input) => {
  // SAFETY: The projection-owned pool is the only sender on this private transport.
  const command = input as SessionListWorkerCommand;
  if (command.kind === "render") {
    return kernel
      ? { kind: "rows", rows: kernel.render(command.rows, command.now) }
      : { kind: "reset" };
  }
  const { update, request } = command;
  if (!kernel && !update.reset) {
    return { kind: "reset" };
  }
  kernel ??= createSessionListWorkerKernel();
  kernel.apply({
    ...update,
    reset:
      // SAFETY: The private sender encodes canonical persisted rows, excluding runtime handles.
      update.reset === undefined ? undefined : (JSON.parse(update.reset) as SessionListWorkerRow[]),
  });
  return { kind: "page", page: kernel.select(request) };
});
