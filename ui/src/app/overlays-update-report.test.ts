// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  createGatewayHarness,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

const reportUpdateFailure = vi.hoisted(() =>
  vi.fn<typeof import("./update-failure-report.ts").reportUpdateFailure>(),
);

vi.mock("./update-failure-report.ts", () => ({ reportUpdateFailure }));

const FAILURE = {
  kind: "update",
  status: "error",
  ts: 1_000,
  stats: {
    handoffId: "handoff-failed",
    reason: "build-failed",
    before: { version: "1.0.0" },
    steps: [{ name: "build", log: { exitCode: 1, stderrTail: "Disk is full" } }],
  },
};

const FAILED_RUN = createUpdateRunFixture({
  phase: "finished",
  status: "failed",
  reason: "build-failed",
  finishedAtMs: 1_000,
});

function harnessFor(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  harness.update({
    selfUser: { id: "gateway-owner" },
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return harness;
}

const requestForStatus = (run: typeof FAILED_RUN | null = FAILED_RUN) =>
  vi.fn<RequestFn>(async (method) => {
    if (method === "update.status") {
      return { lastRun: run, sentinel: FAILURE };
    }
    if (method === "update.runs.get") {
      return { run };
    }
    return {};
  });

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  reportUpdateFailure.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("does not admit a failure report without an identified administrator profile", async () => {
  const request = requestForStatus();
  const harness = harnessFor(request);
  harness.update({ selfUser: null });
  const overlays = createApplicationOverlays(harness.gateway);
  try {
    await flushMicrotasks();
    expect(overlays.snapshot.reportableUpdateFailureId).toBe(FAILED_RUN.runId);
    await overlays.reportUpdateFailure(FAILED_RUN.runId);
    expect(reportUpdateFailure).not.toHaveBeenCalled();
    expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
    expect(overlays.snapshot.updateFailureReportNotice).toBeNull();
  } finally {
    overlays.dispose();
  }
});

describe("update failure report continuity", () => {
  const attemptId = FAILED_RUN.runId;
  it("never reports during status hydration and suppresses duplicate clicks", async () => {
    const request = requestForStatus();
    const harness = harnessFor(request);
    const pending = deferred<{
      status: "created";
      url: string;
    }>();
    reportUpdateFailure.mockReturnValue(pending.promise);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
      expect(reportUpdateFailure).not.toHaveBeenCalled();

      const first = overlays.reportUpdateFailure(attemptId);
      const duplicate = overlays.reportUpdateFailure(attemptId);
      expect(overlays.snapshot.updateFailureReportBusy).toBe(true);
      await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
      pending.resolve({
        status: "created",
        url: "https://github.com/openclaw/openclaw/issues/123",
      });
      await Promise.all([first, duplicate]);

      expect(reportUpdateFailure).toHaveBeenCalledOnce();
      expect(overlays.snapshot.updateFailureReportNotice).toMatchObject({
        attemptId,
        result: { status: "created" },
      });
    } finally {
      overlays.dispose();
    }
  });

  it("invalidates an open confirmation on disconnect and restores only the current action", async () => {
    const request = requestForStatus();
    const harness = harnessFor(request);
    const administrator = harness.gateway.snapshot.hello;
    const first = deferred<null>();
    reportUpdateFailure.mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      const interrupted = overlays.reportUpdateFailure(attemptId);
      await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
      const admission = reportUpdateFailure.mock.calls[0]?.[0];
      expect(admission?.isCurrent?.()).toBe(true);

      harness.update({ phase: "reconnecting", client: null, hello: null, selfUser: null });
      expect(admission?.isCurrent?.()).toBe(false);
      first.resolve(null);
      await interrupted;
      expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
      expect(overlays.snapshot.updateFailureReportNotice).toBeNull();

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
    } finally {
      overlays.dispose();
    }
  });

  it("retains the report action and visible error after submission fails", async () => {
    const request = requestForStatus();
    const harness = harnessFor(request);
    reportUpdateFailure.mockRejectedValue(new Error("unknown method: update.report"));
    const overlays = createApplicationOverlays(harness.gateway);
    try {
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
    } finally {
      overlays.dispose();
    }
  });
});

it.each([{ label: "legacy sentinel", run: null, attemptId: "handoff-failed" }])(
  "keeps a reported $label across reconnect without reporting again",
  async ({ run, attemptId }) => {
    const request = requestForStatus(run);
    const harness = harnessFor(request);
    const hello = harness.gateway.snapshot.hello;
    reportUpdateFailure.mockResolvedValue({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    const overlays = createApplicationOverlays(harness.gateway);
    try {
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
    } finally {
      overlays.dispose();
    }
  },
);

it.each(["changed-facts", "running", "succeeded", "reconciled"] as const)(
  "invalidates report consent when authoritative run becomes %s",
  async (change) => {
    let run =
      change === "reconciled"
        ? createUpdateRunFixture({ ...FAILED_RUN, reason: "abandoned" })
        : FAILED_RUN;
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.status") {
        return { lastRun: run, sentinel: FAILURE };
      }
      if (method === "update.runs.get") {
        return { run };
      }
      return {};
    });
    const harness = harnessFor(request);
    const pending = deferred<null>();
    reportUpdateFailure.mockReturnValue(pending.promise);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      const reporting = overlays.reportUpdateFailure(run.runId);
      await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
      const admission = reportUpdateFailure.mock.calls[0]?.[0];
      expect(admission?.isCurrent?.()).toBe(true);
      run = createUpdateRunFixture({
        ...run,
        updatedAtMs: run.updatedAtMs + 1,
        ...(change === "changed-facts"
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
      harness.emitEvent("update.run.changed", { runId: run.runId, updatedAtMs: run.updatedAtMs });
      expect(admission?.isCurrent?.()).toBe(false);
      await flushMicrotasks();
      expect(overlays.snapshot.reportableUpdateFailureId).toBe(
        change === "changed-facts" ? run.runId : null,
      );
      if (change === "reconciled") {
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(overlays.snapshot.updateRunAcknowledged).toBe(true);
        expect(overlays.snapshot.updateRun?.status).toBe("failed");
      }
      pending.resolve(null);
      await reporting;
      expect(overlays.snapshot.updateFailureReportNotice).toBeNull();
      expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
      expect(reportUpdateFailure).toHaveBeenCalledOnce();
    } finally {
      pending.resolve(null);
      overlays.dispose();
    }
  },
);

it("retires skipped-failure consent when status refresh advances the same run", async () => {
  let run = createUpdateRunFixture({ status: "skipped", phase: "finished", reason: "dirty" });
  const request = vi.fn<RequestFn>(async () => ({ lastRun: run }));
  const harness = harnessFor(request);
  const pending = deferred<null>();
  reportUpdateFailure.mockReturnValue(pending.promise);
  const overlays = createApplicationOverlays(harness.gateway);
  try {
    await flushMicrotasks();
    const reporting = overlays.reportUpdateFailure(run.runId);
    await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
    const admission = reportUpdateFailure.mock.calls[0]?.[0];
    expect(admission?.isCurrent?.()).toBe(true);
    run = { ...run, updatedAtMs: run.updatedAtMs + 1, reason: "not-git-install" };
    await overlays.refreshUpdateStatus();
    expect(admission?.isCurrent?.()).toBe(false);
    expect(overlays.snapshot.reportableUpdateFailureId).toBe(run.runId);
    pending.resolve(null);
    await reporting;
    expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
    expect(overlays.snapshot.updateFailureReportNotice).toBeNull();
  } finally {
    pending.resolve(null);
    overlays.dispose();
  }
});
