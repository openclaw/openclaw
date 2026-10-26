import { afterEach, expect, it, vi } from "vitest";
import {
  markManagedWorktreePreparation,
  setWorktreePreparationTemplate,
  startWorktreePreparationPhase,
  timeWorktreePreparationPhase,
  withWorktreePreparationTiming as withTiming,
} from "./preparation-timing.js";

const { log, event } = vi.hoisted(() => ({ log: vi.fn(), event: vi.fn() }));
// mock-isolation: Observe the preparation receipt without a process-wide diagnostic queue.
vi.mock("../../infra/diagnostic-events.js", () => ({
  createQueuedDiagnosticPhaseEmitter: () => event,
}));
// mock-isolation: Keep the logging sink outside this timing-contract fixture.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ info: log }) }));

afterEach(vi.restoreAllMocks);
afterEach(vi.resetAllMocks);

it("attributes nested preparation once per owner and retains failed phase time", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const failure = new Error("synthetic private setup output");
  const warm = Object.freeze({ reason: "ready", backend: "btrfs", cloneBytes: 42 });
  const phases = { templateApply: 52, containerStart: 8 };
  await expect(
    withTiming("sandbox", async () => {
      markManagedWorktreePreparation();
      setWorktreePreparationTemplate("warm", warm);
      await timeWorktreePreparationPhase("templateApply", async () => {
        clock += 12;
        await withTiming("managed", () =>
          timeWorktreePreparationPhase("checkout", async () => (clock += 40)),
        );
      });
      await timeWorktreePreparationPhase("containerStart", async () => {
        clock += 8;
        throw failure;
      });
    }),
  ).rejects.toBe(failure);
  expect(event.mock.calls[0]?.[0]).toMatchObject({
    durationMs: 40,
    details: { kind: "managed", template: "unavailable", outcome: "returned", checkout: 40 },
  });
  expect(event).toHaveBeenCalledTimes(2);
  expect(event.mock.calls[1]?.[0]).toMatchObject({
    name: "worktree.preparation",
    durationMs: 60,
    details: {
      kind: "sandbox",
      template: "warm",
      outcome: "threw",
      unattributedMs: 0,
      ...phases,
      ...Object.fromEntries(Object.entries(warm).map(([key, value]) => [`template.${key}`, value])),
    },
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message);
});

it("omits unmanaged sandboxes and preserves results if a diagnostics sink fails", async () => {
  await withTiming("sandbox", async () => "unmanaged");
  expect([log.mock.calls, event.mock.calls]).toEqual([[], []]);
  log.mockImplementation(() => {
    throw new Error("log sink unavailable");
  });
  await expect(withTiming("managed", async () => "ready")).resolves.toBe("ready");
});

it("reports uncovered time without double-counting overlapping phases", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  await withTiming("managed", async () => {
    clock = 10;
    const finishBase = startWorktreePreparationPhase("base");
    clock = 20;
    const finishWait = startWorktreePreparationPhase("baseWait");
    clock = 40;
    finishBase();
    finishBase();
    clock = 50;
    finishWait();
    clock = 60;
  });
  expect(log.mock.calls[0]?.[1]).toMatchObject({
    durationMs: 60,
    unattributedMs: 20,
    phaseDurationsMs: { base: 30, baseWait: 30 },
  });
});
