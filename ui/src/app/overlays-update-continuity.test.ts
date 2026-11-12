// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { showToast } from "../lib/toast.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { disposeTestOverlays, requestCalls, runTest } from "./overlays-update.test-support.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

let run: ReturnType<typeof updateRunFixture>;
let request: ReturnType<typeof vi.fn<RequestFn>>;
const calls = (method: string) => requestCalls(request, method);
const acceptedRun = (method: string, status: object = {}) =>
  method === "update.run"
    ? { ok: true, runId: run.runId }
    : method === "update.runs.get"
      ? { run }
      : method === "update.status"
        ? status
        : {};
const finished = { phase: "finished", status: "succeeded", after: { version: "2.0.0" } } as const;
function continuityTest(respond: RequestFn = async (method) => acceptedRun(method)) {
  request = vi.fn(respond);
  return runTest(request);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  run = updateRunFixture();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(async () => {
  await disposeTestOverlays();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reads an accepted run and follows events through restart to a visible success row", async () => {
  const { harness, overlays } = continuityTest(async (method) =>
    acceptedRun(method, run.status === "succeeded" ? { updateAvailable: null } : {}),
  );
  const snapshot = () => overlays.snapshot;
  await flushMicrotasks();
  await overlays.runUpdate();
  expect(snapshot().updateRun).toEqual(run);
  expect(snapshot().updateRunning || snapshot().updateReconciliationPending).toBe(true);

  for (const phase of ["activating", "restarting"] as const) {
    run = updateRunFixture({ phase, updatedAtMs: run.updatedAtMs + 1 });
    harness.emitEvent("update.run.changed", run);
    await flushMicrotasks();
    expect(snapshot().updateRun?.phase).toBe(phase);
  }
  const hello = harness.gateway.snapshot.hello;
  const statusReads = calls("update.status").length;
  const runReads = calls("update.runs.get").length;
  harness.update({ phase: "reconnecting", hello: null });
  await vi.advanceTimersByTimeAsync(40 * 60_000);
  expect(snapshot().updateRun?.phase).toBe("restarting");
  expect(snapshot().updateReconciliationPending || snapshot().updateRunning).toBe(true);
  expect(snapshot().recordedUpdateAttempt).toBeNull();

  run = { ...run, phase: "verifying", updatedAtMs: run.updatedAtMs + 1 };
  harness.update({ phase: "connected", hello });
  await flushMicrotasks();
  expect(snapshot().updateRun?.phase).toBe("verifying");
  expect(calls("update.status")).toHaveLength(statusReads);
  expect(calls("update.runs.get")).toHaveLength(runReads + 1);
  run = {
    ...run,
    ...finished,
    updatedAtMs: run.updatedAtMs + 1,
    finishedAtMs: Date.now(),
    verification: { serviceRunning: true, versionMatch: true, channelsReady: true },
  };
  harness.emitEvent("update.run.changed", run);
  await flushMicrotasks();
  expect(snapshot().updateRun).toEqual(run);
  expect(snapshot()).toMatchObject({
    updateRunning: false,
    updateReconciliationPending: false,
    updateStatusBanner: null,
    updateAvailable: null,
  });
  expect(showToast).not.toHaveBeenCalled();
  expect(calls("update.run")).toHaveLength(1);
  expect(sessionStorage.length).toBe(0);
});

it("does not fetch an unchanged event, but fetches changed step details in the same phase", async () => {
  const { harness, overlays } = continuityTest(async (method) =>
    method === "update.runs.get" ? { run } : { activeRun: run },
  );
  await flushMicrotasks();
  expect(overlays.snapshot.updateRun).toEqual(run);
  harness.emitEvent("update.run.changed", run);
  harness.emitEvent("update.run.changed", run);
  await flushMicrotasks();
  expect(calls("update.runs.get")).toHaveLength(0);
  run = {
    ...run,
    updatedAtMs: run.updatedAtMs + 1,
    steps: [
      ...run.steps,
      { step: "download", status: "in_progress", detail: "Downloading package" },
    ],
  };
  harness.emitEvent("update.run.changed", run);
  await flushMicrotasks();
  expect(calls("update.runs.get")).toHaveLength(1);
  expect(overlays.snapshot.updateRun?.steps.at(-1)?.detail).toBe("Downloading package");
});

it.each(["activeRun", "lastRun"] as const)(
  "discovers %s after a document reload without browser run storage",
  async (field) => {
    run = updateRunFixture(field === "lastRun" ? { ...finished, finishedAtMs: 5_000 } : {});
    const fixture = continuityTest(async (method) =>
      method === "update.status" ? { [field]: run } : {},
    );
    let overlays = fixture.overlays;
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun).toEqual(run);
    overlays = fixture.remount();
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun).toEqual(run);
    expect(calls("update.run")).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
  },
);
