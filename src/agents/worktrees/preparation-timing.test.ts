import { afterEach, expect, it, vi } from "vitest";
import {
  markManagedWorktreePreparation,
  setWorktreePreparationTemplate,
  startWorktreePreparationPhase,
  timeWorktreePreparationPhase,
  withWorktreePreparationTiming as withTiming,
} from "./preparation-timing.js";

const observations = vi.hoisted(() => ({ log: vi.fn(), event: vi.fn() }));
// mock-isolation: Observe the preparation receipt without a process-wide diagnostic queue.
vi.mock("../../infra/diagnostic-events.js", () => ({
  createQueuedDiagnosticPhaseEmitter: () => observations.event,
}));
// mock-isolation: Keep the logging sink outside this timing-contract fixture.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: observations.log }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  observations.log.mockReset();
  observations.event.mockReset();
});

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
        await withTiming("managed", async () => {
          await timeWorktreePreparationPhase("checkout", async () => {
            clock += 40;
          });
        });
      });
      await timeWorktreePreparationPhase("containerStart", async () => {
        clock += 8;
        throw failure;
      });
    }),
  ).rejects.toBe(failure);
  const receipts = [
    ["managed", "unavailable", { reason: "not-requested" }, "returned", 40, { checkout: 40 }],
    ["sandbox", "warm", warm, "threw", 60, phases],
  ] as const;
  expect(observations.log.mock.calls).toEqual(
    receipts.map(([kind, template, templateDetails, outcome, durationMs, phaseDurationsMs]) => [
      "managed worktree preparation",
      {
        kind,
        template,
        templateDetails,
        outcome,
        durationMs,
        phaseDurationsMs,
        unattributedMs: 0,
        consoleMessage: expect.stringContaining(
          `phaseDurationsMs=${JSON.stringify(phaseDurationsMs)}`,
        ),
      },
    ]),
  );
  expect(observations.event).toHaveBeenCalledTimes(2);
  expect(observations.event.mock.calls[1]?.[0]).toMatchObject({
    name: "worktree.preparation",
    durationMs: 60,
    details: {
      kind: "sandbox",
      template: "warm",
      outcome: "threw",
      ...phases,
      ...Object.fromEntries(Object.entries(warm).map(([key, value]) => [`template.${key}`, value])),
    },
  });
  expect(JSON.stringify(observations.log.mock.calls)).not.toContain(failure.message);
});

it("omits unmanaged sandboxes and preserves results if a diagnostics sink fails", async () => {
  await withTiming("sandbox", async () => "unmanaged");
  expect(observations.log).not.toHaveBeenCalled();
  expect(observations.event).not.toHaveBeenCalled();
  observations.log.mockImplementation(() => {
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
  expect(observations.log.mock.calls[0]?.[1]).toMatchObject({
    durationMs: 60,
    unattributedMs: 20,
    phaseDurationsMs: { base: 30, baseWait: 30 },
  });
});
