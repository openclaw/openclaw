import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import type { PublicSessionCard } from "./control-ui-public-session-card-render.js";

export type PublicSessionCardRenderer = {
  render(card: PublicSessionCard): Promise<Buffer>;
  dispose(): Promise<void>;
};

/** The HTTP server owns this pool; importing the module does not start a worker. */
export function createPublicSessionCardRenderer(): PublicSessionCardRenderer {
  const pool = new WorkerTaskPool<PublicSessionCard, Uint8Array>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("publicSessionCard"),
    maxWorkers: 1,
    maxPendingTasks: 8,
    sharedCompute: true,
  });
  return {
    async render(card) {
      const png = await pool.run(card, { timeoutMs: 10_000 });
      return Buffer.from(png.buffer, png.byteOffset, png.byteLength);
    },
    dispose: () => pool.close(),
  };
}
