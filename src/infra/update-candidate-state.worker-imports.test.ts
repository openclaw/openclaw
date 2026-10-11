import { expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({ serve: vi.fn() }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  parentPort: {},
}));
vi.mock("./worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-task-server.js")>()),
  serveWorkerTasks: worker.serve,
}));
// mock-isolation: Throw at the forbidden import boundary instead of loading the snapshot graph into a file worker.
vi.mock("./update-candidate-state.js", () => {
  throw new Error("file workers must not load state snapshot modules");
});
// mock-isolation: Loading the real diagnostics module would defeat the forbidden-import regression.
vi.mock("./update-candidate-state.diagnostics.js", () => {
  throw new Error("file workers must not load subprocess diagnostics");
});

it("starts the file worker without loading the subprocess-only snapshot graph", async () => {
  await import("./update-candidate-state.worker.js");
  expect(worker.serve).toHaveBeenCalledOnce();
});
