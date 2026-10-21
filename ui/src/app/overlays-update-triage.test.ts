// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { client, flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import {
  campaignSchedule,
  disposeTestOverlays,
  runTest,
  updateHello,
} from "./overlays-update.test-support.ts";
import type { ApplicationUpdateOverlayHooks } from "./overlays-updates.ts";

const FAILURE = updateRunFixture({
  status: "failed",
  phase: "finished",
  reason: "build-failed",
  finishedAtMs: 3_000,
  after: { version: "2.0.0" },
  updatedAtMs: 3_000,
  steps: [{ step: "build", status: "failed", detail: "Disk is full" }],
});
const CAMPAIGN = campaignSchedule({
  id: "automatic-attempt",
  state: "applying",
  updatedAtMs: 61_000,
});

function triageTest(request: RequestFn) {
  const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
  return { ...runTest(request, { onUpdateFailure }), onUpdateFailure };
}

async function remountAndDiagnose({ remount, onUpdateFailure }: ReturnType<typeof triageTest>) {
  const overlays = remount();
  await waitForFast(() => expect(overlays.snapshot.updateRun).toEqual(FAILURE));
  expect(onUpdateFailure).toHaveBeenCalledOnce();
  overlays.diagnoseUpdateFailure(FAILURE.runId);
  expect(onUpdateFailure).toHaveBeenCalledTimes(2);
  expect(onUpdateFailure.mock.calls[1]![1].admit()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(async () => {
  await disposeTestOverlays();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a failure passive across events, refreshes, access changes, and reload", async () => {
  let run = updateRunFixture();
  const request = vi.fn<RequestFn>(async (method) =>
    method === "update.runs.get" ? { run } : { lastRun: run },
  );
  const fixture = triageTest(request);
  const { harness, overlays, onUpdateFailure } = fixture;
  const admin = harness.gateway.snapshot.hello;
  await flushMicrotasks();
  expect(onUpdateFailure).not.toHaveBeenCalled();
  run = FAILURE;
  harness.emitEvent("update.run.changed", run);
  await waitForFast(() => expect(overlays.snapshot.diagnosableUpdateFailureId).toBe(FAILURE.runId));
  expect(onUpdateFailure).not.toHaveBeenCalled();
  expect(overlays.snapshot.diagnosableUpdateFailureId).toBe(FAILURE.runId);
  overlays.diagnoseUpdateFailure("stale-attempt");
  expect(onUpdateFailure).not.toHaveBeenCalled();
  overlays.diagnoseUpdateFailure(FAILURE.runId);
  const [failure, admission] = onUpdateFailure.mock.calls[0]!;
  expect(failure).toMatchObject({
    id: FAILURE.runId,
    outcome: "failed",
    attempt: {
      reason: "build-failed",
      beforeVersion: "2026.9.1",
      afterVersion: "2.0.0",
      failure: { step: "build", detail: "Disk is full" },
    },
  });
  expect(overlays.snapshot.updateStatusBanner?.text).toContain("Disk is full");
  expect([admission.admit(), admission.admit()]).toEqual([true, false]);
  harness.emitEvent("update.run.changed", run);
  await overlays.refreshUpdateStatus();
  expect(onUpdateFailure).toHaveBeenCalledOnce();
  harness.update({ hello: updateHello(undefined, "operator.read") });
  expect(overlays.snapshot.updateRun).toBeNull();
  expect(admission.isCurrent()).toBe(false);
  harness.update({ hello: admin });
  await waitForFast(() => expect(overlays.snapshot.updateRun).toEqual(FAILURE));
  expect(onUpdateFailure).toHaveBeenCalledOnce();
  await remountAndDiagnose(fixture);
  expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
});

it.each(["Gateway", "profile", "client", "reconnect"] as const)(
  "retires a queued diagnostic on %s changes without starting another",
  async (boundary) => {
    const request = vi.fn<RequestFn>(async () => ({ lastRun: FAILURE }));
    const fixture = triageTest(request);
    const { harness, overlays, onUpdateFailure } = fixture;
    const initialGateway = harness.gateway.connection.gatewayUrl;
    const admin = harness.gateway.snapshot.hello;
    const originalClient = harness.gateway.snapshot.client;
    const switchScope = (other: boolean) => {
      if (boundary === "client") {
        harness.update({ client: other ? client(request) : originalClient });
        return;
      }
      harness.gateway.connection.gatewayUrl =
        boundary === "Gateway" && other ? "ws://other.test" : initialGateway;
      harness.update({ phase: "connecting", client: null, hello: null });
      harness.update({
        phase: "connected",
        client: boundary === "reconnect" ? originalClient : client(request),
        hello: admin,
        selfUser:
          boundary === "profile" && other
            ? ({ id: "other" } as NonNullable<ApplicationGatewaySnapshot["selfUser"]>)
            : undefined,
      });
    };
    await waitForFast(() =>
      expect(overlays.snapshot.diagnosableUpdateFailureId).toBe(FAILURE.runId),
    );
    expect(onUpdateFailure).not.toHaveBeenCalled();
    overlays.diagnoseUpdateFailure(FAILURE.runId);
    const admission = onUpdateFailure.mock.calls[0]![1];
    switchScope(true);
    await flushMicrotasks();
    expect([admission.isCurrent(), admission.admit()]).toEqual([false, false]);
    expect(onUpdateFailure).toHaveBeenCalledOnce();
    switchScope(false);
    await flushMicrotasks();
    await remountAndDiagnose(fixture);
  },
);

it("retires a queued failure admission when a newer campaign starts", async () => {
  let run = FAILURE;
  const request = vi.fn<RequestFn>(async () => ({ activeRun: run }));
  const { harness, overlays, onUpdateFailure, expectState } = triageTest(request);
  await waitForFast(() => expect(overlays.snapshot.diagnosableUpdateFailureId).toBe(FAILURE.runId));
  overlays.diagnoseUpdateFailure(FAILURE.runId);
  const admission = onUpdateFailure.mock.calls[0]![1];
  run = updateRunFixture({
    runId: "00000000-0000-4000-8000-000000000002",
    createdAtMs: 4_000,
    updatedAtMs: 4_000,
    origin: { campaignId: CAMPAIGN.campaign.id },
  });
  harness.emitEvent("update.available", { schedule: CAMPAIGN });
  expectState({ updateRunning: true, diagnosableUpdateFailureId: null });
  overlays.diagnoseUpdateFailure(FAILURE.runId);
  expect(overlays.snapshot.updateRun).toEqual(FAILURE);
  expect([admission.isCurrent(), admission.admit()]).toEqual([false, false]);
  await overlays.runUpdate();
  expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
  harness.emitEvent("update.run.changed", run);
  await flushMicrotasks();
  expect([admission.isCurrent(), admission.admit()]).toEqual([false, false]);
  expect(overlays.snapshot.updateRun).toEqual(run);
  expectState({ recordedUpdateAttempt: null, diagnosableUpdateFailureId: null });
  overlays.diagnoseUpdateFailure(run.runId);
  expect(onUpdateFailure).toHaveBeenCalledOnce();
});

it("does not turn failed status or hold requests into a failed update", async () => {
  let unavailable = false;
  const { harness, overlays, onUpdateFailure } = triageTest(async (method) => {
    if (unavailable && (method === "update.status" || method === "update.hold")) {
      throw new Error("Unavailable");
    }
    return {};
  });
  await flushMicrotasks();
  unavailable = true;
  await overlays.refreshUpdateStatus();
  harness.emitEvent("update.available", {
    schedule: {
      ...CAMPAIGN,
      campaign: { ...CAMPAIGN.campaign, state: "countdown", applyAtMs: Date.now() + 60_000 },
    },
  });
  await overlays.holdUpdate();
  expect(onUpdateFailure).not.toHaveBeenCalled();
});
it("preserves the sent rejection Invalid update request parameters over historical success", async () => {
  const failure = { code: "INVALID_REQUEST", message: "Invalid update request parameters" };
  const previous = updateRunFixture({
    status: "succeeded",
    phase: "finished",
    finishedAtMs: 3_000,
  });
  const request = vi.fn<RequestFn>(async (method, _params, options) => {
    if (method === "update.run") {
      options?.onSent?.("update-run-request");
      throw new GatewayRequestError(failure);
    }
    return method === "update.status" ? { lastRun: previous } : {};
  });
  const { overlays, expectState } = runTest(request);
  await flushMicrotasks();
  expect(overlays.snapshot.updateRun).toEqual(previous);
  await overlays.runUpdate();
  expectState({
    updateStatusBanner: { text: expect.stringContaining(failure.message) },
    updateRun: null,
    updateRunning: false,
  });
});

it("admits each explicit click once when session storage is available", async () => {
  const { overlays, onUpdateFailure } = triageTest(async () => ({ lastRun: FAILURE }));
  await waitForFast(() => expect(overlays.snapshot.diagnosableUpdateFailureId).toBe(FAILURE.runId));
  expect(onUpdateFailure).not.toHaveBeenCalled();
  overlays.diagnoseUpdateFailure(FAILURE.runId);
  const first = onUpdateFailure.mock.calls[0]![1];
  overlays.diagnoseUpdateFailure(FAILURE.runId);
  const second = onUpdateFailure.mock.calls[1]![1];
  expect([first.isCurrent(), first.admit()]).toEqual([false, false]);
  expect([second.admit(), second.admit()]).toEqual([true, false]);
  overlays.diagnoseUpdateFailure(FAILURE.runId);
  expect(onUpdateFailure.mock.calls[2]![1].admit()).toBe(true);
  expect(onUpdateFailure).toHaveBeenCalledTimes(3);
});
