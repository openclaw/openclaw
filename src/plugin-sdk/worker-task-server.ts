// Worker-side task serving without the host process and pool runtime.
export { serveWorkerTasks, type WorkerTaskChannel } from "../infra/worker-task-server.js";
export type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
