// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { client, flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import {
  disposeTestOverlays,
  runTest,
  settleAtCleanup,
  pendingReply,
  updateHello,
  updateStatusRequest,
} from "./overlays-update.test-support.ts";

function admissionTest(status: (sent: boolean) => unknown, getRun: () => unknown = () => ({})) {
  const admission = pendingReply({});
  let sent = false;
  const request = vi.fn<RequestFn>(async (method, _params, options) => {
    if (method === "update.run") {
      options?.onSent?.("update-run-request");
      sent = true;
      return admission.promise;
    }
    return method === "update.status" ? status(sent) : method === "update.runs.get" ? getRun() : {};
  });
  return { ...runTest(request), admission, request };
}

afterEach(async () => {
  await disposeTestOverlays();
  vi.restoreAllMocks();
});

describe("update run response races", () => {
  it("retires privileged run facts when reconnect authenticates without administrator access", async () => {
    const run = updateRunFixture({
      phase: "finished",
      status: "failed",
      reason: "build-failed",
      finishedAtMs: 3_000,
    });
    const request = updateStatusRequest(() => ({ lastRun: run }));
    const { harness, overlays, expectState } = runTest(request);
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun).toEqual(run);
    expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
    harness.update({ phase: "reconnecting", hello: null });
    expect(overlays.snapshot.updateRun).toEqual(run);
    // A build-skew handshake publishes its new auth before connection admission.
    harness.update({
      phase: "reconnecting",
      hello: updateHello(undefined, "operator.read"),
    });
    harness.update({ phase: "connected" });
    expectState({ updateRun: null, recordedUpdateAttempt: null, updateStatusBanner: null });
  });

  it.each(["activeRun", "lastRun"] as const)(
    "discovers %s when disconnect wins the admission reply",
    async (field) => {
      const run = updateRunFixture(
        field === "lastRun"
          ? {
              phase: "finished",
              status: "succeeded",
              after: { version: "2.0.0" },
              finishedAtMs: 3_000,
            }
          : {},
      );
      const { overlays, admission, request, reconnect } = admissionTest((sent) =>
        sent ? { [field]: run } : {},
      );
      await flushMicrotasks();
      const running = settleAtCleanup(overlays.runUpdate());
      await flushMicrotasks();
      reconnect();
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(run);
      admission.reject(new Error("old socket closed"));
      await running;
      expect(overlays.snapshot.updateRun).toEqual(run);
      expect(overlays.snapshot.updateStatusBanner).toBeNull();
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
    },
  );

  it.each(["Gateway", "profile", "administrator", "dispose"] as const)(
    "discards a run read after changing %s",
    async (boundary) => {
      const pending = pendingReply({});
      const run = updateRunFixture();
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.runs.get" ? pending.promise : {},
      );
      const { harness, overlays, expectState } = runTest(request);
      await flushMicrotasks();
      harness.emitEvent("update.run.changed", run);
      await flushMicrotasks();
      expect(request.mock.calls.some(([method]) => method === "update.runs.get")).toBe(true);
      if (boundary === "Gateway") {
        harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
        harness.update({ phase: "connecting", client: null, hello: null });
      } else if (boundary === "profile") {
        harness.update({
          selfUser: { id: "other" } as NonNullable<ApplicationGatewaySnapshot["selfUser"]>,
        });
      } else if (boundary === "administrator") {
        harness.update({
          hello: updateHello(undefined, "operator.read"),
        });
      } else {
        overlays.dispose();
      }
      pending.resolve({ run });
      await flushMicrotasks();
      expectState({ updateRun: null, recordedUpdateAttempt: null });
    },
  );

  it("ignores a retired reconnect response after a replacement connection reads the final row", async () => {
    const pending = pendingReply({});
    const run = updateRunFixture();
    let reads = 0;
    const firstRequest = vi.fn<RequestFn>(async (method) => {
      if (method === "update.run") {
        return { ok: true, runId: run.runId };
      }
      if (method === "update.runs.get") {
        return ++reads === 1 ? { run } : pending.promise;
      }
      return {};
    });
    const finished = {
      ...run,
      status: "succeeded" as const,
      phase: "finished" as const,
      updatedAtMs: 4_000,
      finishedAtMs: 4_000,
      after: { version: "2.0.0" },
    };
    const replacement = vi.fn<RequestFn>(async (method) =>
      method === "update.runs.get" ? { run: finished } : {},
    );
    const { harness, overlays, reconnect } = runTest(firstRequest);
    await overlays.runUpdate();
    reconnect();
    await flushMicrotasks();
    harness.update({ phase: "reconnecting" });
    harness.update({ phase: "connected", client: client(replacement) });
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun).toEqual(finished);
    pending.resolve({ run: { ...run, phase: "verifying", updatedAtMs: 3_000 } });
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun).toEqual(finished);
  });

  it("does not send an update after the config-write barrier loses its authority", async () => {
    const drained = pendingReply(undefined);
    const request = vi.fn<RequestFn>(async () => ({}));
    const { harness, overlays } = runTest(request, {
      drainConfigWrites: () => drained.promise,
    });
    const running = settleAtCleanup(overlays.runUpdate());
    expect(overlays.snapshot.updateRunning).toBe(true);
    harness.update({
      hello: updateHello(undefined, "operator.read"),
    });
    drained.resolve(undefined);
    await running;
    expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
    expect(overlays.snapshot.updateRunning).toBe(false);
  });
  it.each([
    { baseline: "unknown", discovered: "old", attach: false },
    { baseline: "unknown", discovered: "old after disconnect", attach: false },
    { baseline: "previous", discovered: "old", attach: false },
    { baseline: "previous", discovered: "new", attach: true },
    { baseline: "empty", discovered: "new", attach: true },
    { baseline: "unknown", discovered: "active", attach: true },
  ] as const)(
    "reconciles lost admission using $baseline history and $discovered run identity",
    async ({ baseline, discovered, attach }) => {
      const previous = updateRunFixture({
        status: "succeeded",
        phase: "finished",
        finishedAtMs: 3_000,
      });
      let found = discovered.startsWith("old")
        ? previous
        : updateRunFixture({
            runId: "00000000-0000-4000-8000-000000000002",
            ...(discovered === "active"
              ? {}
              : { status: "succeeded", phase: "finished", finishedAtMs: 4_000 }),
          });
      const { harness, overlays, expectState, admission, request } = admissionTest(
        (requested) => {
          if (!requested) {
            if (baseline === "unknown") {
              throw new Error("Initial history unavailable");
            }
            return baseline === "previous" ? { lastRun: previous } : {};
          }
          return found.status === "running" ? { activeRun: found } : { lastRun: found };
        },
        () => ({ run: found }),
      );
      const outcome =
        discovered === "old after disconnect" ? "outcome is unknown" : "Admission reply lost";
      await flushMicrotasks();
      const operation = settleAtCleanup(overlays.runUpdate());
      await flushMicrotasks();
      if (discovered === "old after disconnect") {
        harness.update({ phase: "reconnecting" });
      }
      admission.reject(new Error("Admission reply lost"));
      if (discovered === "old after disconnect") {
        harness.update({ phase: "connected" });
      }
      await operation;
      await flushMicrotasks();
      if (attach) {
        expect(overlays.snapshot.updateRun).toEqual(found);
        if (discovered === "active") {
          found = {
            ...found,
            status: "succeeded",
            phase: "finished",
            finishedAtMs: 4_000,
            updatedAtMs: 4_000,
          };
          harness.emitEvent("update.run.changed", found);
          await flushMicrotasks();
          expect(overlays.snapshot.updateRun).toEqual(found);
        }
      } else {
        expectState({
          updateRun: null,
          updateStatusBanner: { tone: "danger", text: expect.stringContaining(outcome) },
          updateRunning: false,
        });
        harness.update({ phase: "reconnecting" });
        harness.update({ phase: "connected" });
        await flushMicrotasks();
        harness.emitEvent("update.run.changed", { ...previous, updatedAtMs: 4_000 });
        await flushMicrotasks();
        expectState({
          updateRun: null,
          updateStatusBanner: { text: expect.stringContaining(outcome) },
        });
        await overlays.refreshUpdateStatus();
        expectState({
          updateRun: null,
          updateStatusBanner: { text: expect.stringContaining(outcome) },
        });
      }
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
    },
  );
});
