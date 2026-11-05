import { afterEach, expect, it, vi } from "vitest";
import { withWorktreePreparationTiming } from "./preparation-timing.js";
import { copyProvisionedPathsInWorker } from "./provisioned-copy-host.js";

const { run, poolOptions, log, event } = vi.hoisted(() => ({
  run: vi.fn(),
  poolOptions: vi.fn(),
  log: vi.fn(),
  event: vi.fn(),
}));
// mock-isolation: The copy host owns this synthetic transport, pool lifetime and telemetry sinks.
vi.mock("../../infra/worker-task-pool.js", () => ({
  WorkerTaskPool: class {
    constructor(options: unknown) {
      poolOptions(options);
    }
    run = run;
  },
  WorkerTaskError: class extends Error {},
}));
// mock-isolation: Each test owns its pool; do not retain it in process-global state.
vi.mock("../../shared/global-singleton.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/global-singleton.js")>()),
  resolveGlobalSingleton: (_key: symbol, create: () => unknown) => create(),
}));
// mock-isolation: Observe the receipt without dispatching diagnostics outside the fixture.
vi.mock("../../infra/diagnostic-events.js", () => ({
  createQueuedDiagnosticPhaseEmitter: () => event,
}));
// mock-isolation: Timeline storage is outside the timing/authority contract.
vi.mock("../../infra/diagnostics-timeline.js", () => ({
  recordDiagnosticsTimelineDuration: vi.fn(),
}));
// mock-isolation: Capture preparation output without a process-wide logging sink.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ info: log }) }));
afterEach(vi.restoreAllMocks);
afterEach(vi.resetAllMocks);

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
      // Later file mutations recheck authority without restarting the copy span.
      for (clock of [40, 50]) {
        Atomics.store(new Int32Array(input.decision), 0, 0);
        options.onNotification();
        expect(Atomics.load(new Int32Array(input.decision), 0)).toBe(1);
      }
      clock = 65;
      if (outcome === "copy-failure") {
        throw failure;
      }
      return {
        type: "provisioned",
        paths: ["file"],
        diagnostics: { workerMs: 25, authorityWaitMs: 10 },
      };
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
    const waiting = outcome === "waiting-failure" || outcome === "skipped";
    expect(receipt.phaseDurationsMs).toEqual(
      waiting ? { provisionCopyWait: 40 } : { provisionCopyWait: 40, provisionCopy: 25 },
    );
    expect(receipt.unattributedMs).toBe(0);
    if (outcome === "returned") {
      expect(receipt.copyDetails.workerMs).toBe(25);
      expect(receipt.copyDetails.authorityWaitMs).toBe(10);
      expect(receipt.copyDetails.roundTripResidualApproxMs).toBe(40);
    }
    expect(receipt.copyDetails.roundTripMs).toBe(waiting ? 40 : 65);
    if (outcome === "waiting-failure" || outcome === "copy-failure") {
      expect(receipt.errorPhase).toBe(
        outcome === "waiting-failure" ? "provisionCopyWait" : "provisionCopy",
      );
    }
  },
);
