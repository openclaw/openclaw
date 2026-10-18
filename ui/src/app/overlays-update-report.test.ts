// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import {
  client,
  createGatewayHarness,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import {
  updateFixture,
  disposeTestOverlays,
  pendingReply,
  updateHello,
  updateSentinel,
} from "./overlays-update.test-support.ts";

const reportUpdateFailure = vi.hoisted(() =>
  vi.fn<typeof import("./update-failure-report.ts").reportUpdateFailure>(),
);

vi.mock("./update-failure-report.ts", () => ({ reportUpdateFailure }));

const FAILURE = updateSentinel("build-failed", 1_000, {
  handoffId: "handoff-failed",
  before: { version: "1.0.0" },
  steps: [{ name: "build", log: { exitCode: 1, stderrTail: "Disk is full" } }],
});

const FAILED_RUN = createUpdateRunFixture({
  phase: "finished",
  status: "failed",
  reason: "build-failed",
  finishedAtMs: 1_000,
});

function reportTest(
  getRun: () => typeof FAILED_RUN | null = () => FAILED_RUN,
  profile: string | null = "gateway-owner",
) {
  const request = vi.fn<RequestFn>(async (method) => {
    const run = getRun();
    return method === "update.status"
      ? { lastRun: run, sentinel: FAILURE }
      : method === "update.runs.get"
        ? { run }
        : {};
  });
  const harness = createGatewayHarness(client(request));
  harness.update({ selfUser: profile === null ? null : { id: profile }, hello: updateHello() });
  return { ...updateFixture(harness), request };
}

async function beginReport(overlays: ReturnType<typeof updateFixture>["overlays"], id: string) {
  const reporting = overlays.reportUpdateFailure(id);
  await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
  const admission = reportUpdateFailure.mock.calls[0]?.[0];
  expect(admission?.isCurrent?.()).toBe(true);
  return { reporting, admission };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  reportUpdateFailure.mockReset();
});

afterEach(async () => {
  await disposeTestOverlays();
  vi.unstubAllGlobals();
});

it("does not admit a failure report without an identified administrator profile", async () => {
  const { overlays, expectState } = reportTest(undefined, null);
  await flushMicrotasks();
  expect(overlays.snapshot.reportableUpdateFailureId).toBe(FAILED_RUN.runId);
  await overlays.reportUpdateFailure(FAILED_RUN.runId);
  expect(reportUpdateFailure).not.toHaveBeenCalled();
  expectState({ updateFailureReportBusy: false, updateFailureReportNotice: null });
});

describe("update failure report continuity", () => {
  const attemptId = FAILED_RUN.runId;
  it("never reports during status hydration and suppresses duplicate clicks", async () => {
    const { overlays } = reportTest();
    const pending = deferred<{ status: "created"; url: string }>();
    reportUpdateFailure.mockReturnValue(pending.promise);
    await flushMicrotasks();
    expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
    expect(reportUpdateFailure).not.toHaveBeenCalled();

    const first = overlays.reportUpdateFailure(attemptId);
    const duplicate = overlays.reportUpdateFailure(attemptId);
    expect(overlays.snapshot.updateFailureReportBusy).toBe(true);
    await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
    pending.resolve({ status: "created", url: "https://github.com/openclaw/openclaw/issues/123" });
    await Promise.all([first, duplicate]);

    expect(reportUpdateFailure).toHaveBeenCalledOnce();
    expect(overlays.snapshot.updateFailureReportNotice).toMatchObject({
      attemptId,
      result: { status: "created" },
    });
  });

  it("invalidates an open confirmation on disconnect and restores only the current action", async () => {
    const { harness, overlays, request, expectState } = reportTest();
    const administrator = harness.gateway.snapshot.hello;
    const first = deferred<null>();
    reportUpdateFailure.mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
    await flushMicrotasks();
    const { reporting: interrupted, admission } = await beginReport(overlays, attemptId);

    harness.update({ phase: "reconnecting", client: null, hello: null, selfUser: null });
    expect(admission?.isCurrent?.()).toBe(false);
    first.resolve(null);
    await interrupted;
    expectState({ updateFailureReportBusy: false, updateFailureReportNotice: null });

    harness.update({
      phase: "connected",
      client: client(request),
      hello: administrator,
      selfUser: { id: "gateway-owner" },
    });
    await flushMicrotasks();
    expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
    expect(admission?.isCurrent?.()).toBe(false);
    await overlays.reportUpdateFailure(attemptId);
    expect(reportUpdateFailure).toHaveBeenCalledTimes(2);
  });

  it("retains the report action and visible error after submission fails", async () => {
    const { overlays } = reportTest();
    reportUpdateFailure.mockRejectedValue(new Error("unknown method: update.report"));
    await flushMicrotasks();
    await overlays.reportUpdateFailure(attemptId);

    expect(overlays.snapshot.updateFailureReportNotice).toMatchObject({
      attemptId,
      result: { status: "error", message: expect.stringContaining("unknown method") },
    });
    expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
    await overlays.refreshUpdateStatus();
    expect(reportUpdateFailure).toHaveBeenCalledOnce();
    expect(overlays.snapshot.updateFailureReportNotice?.result.status).toBe("error");
  });
});

it("keeps a reported legacy sentinel across reconnect without reporting again", async () => {
  const attemptId = "handoff-failed";
  const { harness, overlays, request } = reportTest(() => null);
  const hello = harness.gateway.snapshot.hello;
  reportUpdateFailure.mockResolvedValue({
    status: "created",
    url: "https://github.com/openclaw/openclaw/issues/123",
  });
  await flushMicrotasks();
  await overlays.reportUpdateFailure(attemptId);
  const notice = overlays.snapshot.updateFailureReportNotice;
  harness.update({ phase: "reconnecting", client: null, hello: null, selfUser: null });
  harness.update({
    phase: "connected",
    client: client(request),
    hello,
    selfUser: { id: "gateway-owner" },
  });
  await flushMicrotasks();
  expect(overlays.snapshot.updateFailureReportNotice).toEqual(notice);
  expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
  expect(reportUpdateFailure).toHaveBeenCalledOnce();
});

it.each(["changed-facts", "running", "succeeded", "reconciled", "skipped"] as const)(
  "invalidates report consent when authoritative run becomes %s",
  async (change) => {
    let run =
      change === "reconciled"
        ? createUpdateRunFixture({ ...FAILED_RUN, reason: "abandoned" })
        : change === "skipped"
          ? createUpdateRunFixture({ status: "skipped", phase: "finished", reason: "dirty" })
          : FAILED_RUN;
    const { harness, overlays, expectState } = reportTest(() => run);
    const pending = pendingReply(null);
    reportUpdateFailure.mockReturnValue(pending.promise);
    await flushMicrotasks();
    const { reporting, admission } = await beginReport(overlays, run.runId);
    run = createUpdateRunFixture({
      ...run,
      updatedAtMs: run.updatedAtMs + 1,
      ...(change === "skipped"
        ? { reason: "not-git-install" }
        : change === "changed-facts"
          ? { after: { version: "2026.9.3" } }
          : change === "reconciled"
            ? {
                steps: [
                  ...run.steps,
                  { step: "reconcile:acknowledged", status: "completed" as const },
                ],
              }
            : { status: change, phase: change === "running" ? "staging" : "finished" }),
    });
    if (change === "skipped") {
      await overlays.refreshUpdateStatus();
    } else {
      harness.emitEvent("update.run.changed", { runId: run.runId, updatedAtMs: run.updatedAtMs });
    }
    expect(admission?.isCurrent?.()).toBe(false);
    await flushMicrotasks();
    expect(overlays.snapshot.reportableUpdateFailureId).toBe(
      change === "changed-facts" || change === "skipped" ? run.runId : null,
    );
    if (change === "reconciled") {
      expectState({
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
        updateRunAcknowledged: true,
        updateRun: { status: "failed" },
      });
    }
    pending.resolve(null);
    await reporting;
    expectState({ updateFailureReportNotice: null, updateFailureReportBusy: false });
    expect(reportUpdateFailure).toHaveBeenCalledOnce();
  },
);
