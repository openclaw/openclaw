// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { renderUpdateRunReport } from "../../../src/infra/update-run-report.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

type Run = ReturnType<typeof createUpdateRunFixture>;
async function start(patch: Partial<Run>, retry = false) {
  vi.useFakeTimers();
  let run = createUpdateRunFixture({
    runId: "ocm:fixture",
    target: { installationMethod: "ocm" },
    ...patch,
  });
  const read = vi.fn(async () => ({ run }));
  if (retry) {
    read.mockRejectedValueOnce(new Error("Status temporarily unavailable"));
  }
  const request = vi.fn<RequestFn>(async (method) =>
    method === "update.runs.get"
      ? read()
      : method === "update.run"
        ? {
            ok: true,
            runId: run.runId,
            ...(retry && { handoff: { status: "started" } }),
          }
        : {},
  );
  const harness = updateRunHarness(request);
  const overlays = createApplicationOverlays(harness.gateway);
  dispose = () => overlays.dispose();
  await flushMicrotasks();
  await overlays.runUpdate();
  return {
    harness,
    overlays,
    request,
    run,
    update: (change: Partial<Run>) => {
      run = { ...run, updatedAtMs: run.updatedAtMs + 1, ...change };
      return run;
    },
  };
}

async function expectPollingStopped(request: ReturnType<typeof vi.fn<RequestFn>>) {
  const reads = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls.length).toBe(reads);
}

it("retries the first accepted OCM job read without reconnecting or resubmitting", async () => {
  const { overlays, request, run } = await start({ phase: "finished", status: "succeeded" }, true);
  expect(overlays.snapshot.updateReconciliationPending).toBe(true);
  expect(overlays.snapshot.updateStatusBanner?.text).toContain("Status temporarily unavailable");
  await overlays.runUpdate();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(overlays.snapshot.updateRun).toEqual(run);
  expect(overlays.snapshot.updateReconciliationPending).toBe(false);
  expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
  await expectPollingStopped(request);
});

it("polls an OCM job through disconnect and failure without native recovery actions", async () => {
  const { harness, overlays, request, update } = await start({
    origin: { nextAction: "Check this update through OCM." },
  });
  let run = update({
    steps: [{ step: "OCM update", status: "in_progress", detail: "Preparing package" }],
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(overlays.snapshot.updateRun?.steps[0]?.detail).toBe("Preparing package");
  expect(renderUpdateRunReport(run).markdown).not.toContain("openclaw update status");
  const hello = harness.gateway.snapshot.hello;
  harness.update({ phase: "reconnecting", hello: null });
  await expectPollingStopped(request);
  run = update({
    phase: "finished",
    status: "failed",
    reason: "ocm-update-failed",
  });
  harness.update({ phase: "connected", hello });
  await waitForFast(() => expect(overlays.snapshot.updateRun).toEqual(run));
  expect(overlays.snapshot).toMatchObject({
    updateRunning: false,
    diagnosableUpdateFailureId: null,
    reportableUpdateFailureId: null,
  });
  expect(renderUpdateRunReport(run).markdown).toContain("Check this update through OCM.");
  expect(renderUpdateRunReport(run).markdown).not.toContain("openclaw triage");
  await expectPollingStopped(request);
});
