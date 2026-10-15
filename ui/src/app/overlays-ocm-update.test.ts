// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { renderUpdateRunReport } from "../../../src/infra/update-run-report.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

afterEach(() => vi.useRealTimers());

it("retries the first accepted OCM job read without reconnecting or resubmitting", async () => {
  vi.useFakeTimers();
  const run = createUpdateRunFixture({
    runId: "ocm:fixture",
    target: { installationMethod: "ocm" },
    phase: "finished",
    status: "succeeded",
  });
  let firstRead = true;
  const request = vi.fn<RequestFn>(async (method) => {
    if (method === "update.run") {
      return { ok: true, runId: run.runId, handoff: { status: "started" } };
    }
    if (method === "update.runs.get") {
      if (firstRead) {
        firstRead = false;
        throw new Error("Status temporarily unavailable");
      }
      return { run };
    }
    return {};
  });
  const harness = updateRunHarness(request);
  const overlays = createApplicationOverlays(harness.gateway);
  try {
    await flushMicrotasks();
    await overlays.runUpdate();
    expect(overlays.snapshot.updateReconciliationPending).toBe(true);
    expect(overlays.snapshot.updateStatusBanner?.text).toContain("Status temporarily unavailable");
    await overlays.runUpdate();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(overlays.snapshot.updateRun).toEqual(run);
    expect(overlays.snapshot.updateReconciliationPending).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
    const settledReads = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request.mock.calls.length).toBe(settledReads);
  } finally {
    overlays.dispose();
  }
});

it("polls an OCM job through disconnect and failure without native recovery actions", async () => {
  vi.useFakeTimers();
  let run = createUpdateRunFixture({
    runId: "ocm:fixture",
    target: { installationMethod: "ocm" },
    origin: { nextAction: "Check this update through OCM." },
  });
  const request = vi.fn<RequestFn>(async (method) =>
    method === "update.runs.get"
      ? { run }
      : method === "update.run"
        ? { ok: true, runId: run.runId }
        : {},
  );
  const harness = updateRunHarness(request);
  const overlays = createApplicationOverlays(harness.gateway);
  try {
    await flushMicrotasks();
    await overlays.runUpdate();
    run = {
      ...run,
      updatedAtMs: run.updatedAtMs + 1,
      steps: [{ step: "OCM update", status: "in_progress", detail: "Preparing package" }],
    };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(overlays.snapshot.updateRun?.steps[0]?.detail).toBe("Preparing package");
    expect(renderUpdateRunReport(run).markdown).not.toContain("openclaw update status");
    const hello = harness.gateway.snapshot.hello;
    harness.update({ phase: "reconnecting", hello: null });
    const reads = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request.mock.calls.length).toBe(reads);
    run = {
      ...run,
      updatedAtMs: run.updatedAtMs + 1,
      phase: "finished",
      status: "failed",
      reason: "ocm-update-failed",
    };
    harness.update({ phase: "connected", hello });
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun).toEqual(run);
    expect(overlays.snapshot.updateRunning).toBe(false);
    expect(overlays.snapshot.diagnosableUpdateFailureId).toBeNull();
    expect(overlays.snapshot.reportableUpdateFailureId).toBeNull();
    expect(renderUpdateRunReport(run).markdown).toContain("Check this update through OCM.");
    expect(renderUpdateRunReport(run).markdown).not.toContain("openclaw triage");
    const settledReads = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request.mock.calls.length).toBe(settledReads);
  } finally {
    overlays.dispose();
  }
});
