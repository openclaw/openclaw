import { vi } from "vitest";
import { interceptWorkerExecution } from "./store.test-support.js";

const delivery = vi.hoisted(() => ({
  command: undefined as string | undefined,
  afterCommit: undefined as (() => Promise<void>) | undefined,
}));
export { delivery };

// mock-isolation: Hold only reply publication after the real worker operation commits.
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return interceptWorkerExecution(actual, (scope) => async (command, executeOptions) => {
    const result = await scope.execute(command, executeOptions);
    if (command.type === delivery.command) {
      await delivery.afterCommit?.();
    }
    return result;
  });
});
