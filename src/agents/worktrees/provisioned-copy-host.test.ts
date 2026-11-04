import { afterEach, expect, it, vi } from "vitest";
import { withWorktreePreparationTiming } from "./preparation-timing.js";
import { copyProvisionedPathsInWorker } from "./provisioned-copy-host.js";

const { run, poolOptions, log, event } = vi.hoisted(() => ({
  run: vi.fn(),
  poolOptions: vi.fn(),
  log: vi.fn(),
  event: vi.fn(),
}));
// Only the worker transport is simulated; timing and host authority are the production owners.
vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/worker-task-pool.js")>()),
  WorkerTaskPool: class {
    constructor(options: unknown) {
      poolOptions(options);
    }
    run = run;
  },
  WorkerTaskError: class extends Error {},
}));
vi.mock("../../infra/runtime-worker-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/runtime-worker-url.js")>()),
  resolveRuntimeWorkerUrl: () => new URL("file:///copy-worker.js"),
}));
vi.mock("../../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) =>
      args[0] === Symbol.for("openclaw.worktreeProvisionCopies")
        ? args[1]()
        : actual.resolveGlobalSingleton(...args),
  };
});
vi.mock("../../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/diagnostic-events.js")>()),
  createQueuedDiagnosticPhaseEmitter: () => event,
}));
vi.mock("../../infra/diagnostics-timeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/diagnostics-timeline.js")>()),
  recordDiagnosticsTimelineDuration: vi.fn(),
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ info: log }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each(["returned", "skipped", "waiting-failure", "copy-failure"] as const)(
  "separates waiting from active copying on %s",
  async (outcome) => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const failure = new Error("copy refused");
    const assertCurrent = vi.fn();
    run.mockImplementation(async (input, options) => {
      clock = 40;
      if (outcome === "waiting-failure") {
        throw failure;
      }
      if (outcome === "skipped") {
        return { type: "provisioned", paths: [] };
      }
      options.onNotification();
      expect(Atomics.load(new Int32Array(input.decision), 0)).toBe(1);
      // Later file mutations recheck authority without restarting the copy span.
      clock = 50;
      Atomics.store(new Int32Array(input.decision), 0, 0);
      options.onNotification();
      expect(Atomics.load(new Int32Array(input.decision), 0)).toBe(1);
      clock = 65;
      if (outcome === "copy-failure") {
        throw failure;
      }
      return { type: "provisioned", paths: ["file"] };
    });
    const pending = withWorktreePreparationTiming("managed", () =>
      copyProvisionedPathsInWorker("source", "destination", ["file"], { assertCurrent }),
    );
    if (outcome === "returned" || outcome === "skipped") {
      await expect(pending).resolves.toEqual(outcome === "returned" ? ["file"] : []);
      expect(assertCurrent).toHaveBeenCalledTimes(outcome === "returned" ? 4 : 2);
    } else {
      await expect(pending).rejects.toBe(failure);
    }
    expect(poolOptions).toHaveBeenCalledWith(expect.objectContaining({ maxWorkers: 2 }));
    const receipt = log.mock.calls[0]?.[1];
    expect(receipt.phaseDurationsMs).toEqual(
      outcome === "waiting-failure" || outcome === "skipped"
        ? { provisionCopyWait: 40 }
        : { provisionCopyWait: 40, provisionCopy: 25 },
    );
    expect(receipt.unattributedMs).toBe(0);
    if (outcome === "waiting-failure" || outcome === "copy-failure") {
      expect(receipt.errorPhase).toBe(
        outcome === "waiting-failure" ? "provisionCopyWait" : "provisionCopy",
      );
    }
  },
);
