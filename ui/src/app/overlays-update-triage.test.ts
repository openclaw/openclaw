// @vitest-environment node
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { client, flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import type { ApplicationUpdateOverlayHooks } from "./overlays-updates.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { createUpdateRunReceipts } from "./update-run-receipts.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

const FAILURE = updateRunFixture({
  status: "failed",
  phase: "finished",
  reason: "build-failed",
  finishedAtMs: 3_000,
  after: { version: "2.0.0" },
  updatedAtMs: 3_000,
  steps: [{ step: "build", status: "failed", detail: "Disk is full" }],
});
const CAMPAIGN = {
  channel: "stable",
  autoEnabled: true,
  campaign: {
    id: "automatic-attempt",
    state: "applying",
    announcedAtMs: 1_000,
    forceAtMs: 901_000,
    updatedAtMs: 61_000,
  },
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("update failure triage admission", () => {
  it("bounds transient failed-save declines without clearing the other retained runs", async () => {
    const runAt = (index: number) => ({
      ...FAILURE,
      runId: `declined-${index}`,
      createdAtMs: 4_000 + index,
      updatedAtMs: 4_000 + index,
    });
    let run = runAt(0);
    const harness = updateRunHarness(async () => ({ lastRun: run }));
    const gatewayUrl = harness.gateway.connection.gatewayUrl;
    const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    const save = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    const returnToRun = async (index: number) => {
      run = runAt(index);
      harness.gateway.connection.gatewayUrl = "ws://other.test";
      harness.update({});
      await flushMicrotasks();
      harness.gateway.connection.gatewayUrl = gatewayUrl;
      harness.update({});
      await flushMicrotasks();
      return onUpdateFailure.mock.calls.at(-1)![1];
    };
    try {
      await flushMicrotasks();
      for (let index = 0; index <= 32; index++) {
        run = runAt(index);
        await overlays.refreshUpdateStatus();
        expect(onUpdateFailure.mock.calls.at(-1)![1].optOut.apply()).toBe(false);
      }
      const retained = await returnToRun(1);
      expect(retained.optOut.notice()).toBe("save-failed");
      expect(retained.admit()).toBe(false);
      const evicted = await returnToRun(0);
      expect(evicted.optOut.notice()).toBeNull();
      expect(evicted.admit()).toBe(true);
      expect(localStorage.getItem("openclaw:control-ui:update-triage-opt-out:v1")).toBeNull();
    } finally {
      save.mockRestore();
      overlays.dispose();
    }
  });

  it.each(["Gateway", "profile"] as const)(
    "retains a failed-save decline after returning to its %s without retaining callbacks",
    async (boundary) => {
      let run = FAILURE;
      const request = vi.fn<RequestFn>(async () => ({ lastRun: run }));
      const harness = updateRunHarness(request);
      const initialGateway = harness.gateway.connection.gatewayUrl;
      const admin = harness.gateway.snapshot.hello;
      const onUpdateFailure =
        vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
      let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      const save = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage full");
      });
      const switchScope = (other: boolean) => {
        harness.gateway.connection.gatewayUrl =
          boundary === "Gateway" && other ? "ws://other.test" : initialGateway;
        harness.update({ phase: "connecting", client: null, hello: null });
        harness.update({
          phase: "connected",
          client: client(request),
          hello: admin,
          selfUser:
            boundary === "profile" && other
              ? ({ id: "other" } as NonNullable<ApplicationGatewaySnapshot["selfUser"]>)
              : undefined,
        });
      };
      try {
        await flushMicrotasks();
        const original = onUpdateFailure.mock.calls[0]![1];
        expect(original.optOut.apply()).toBe(false);
        expect(original.admit()).toBe(false);
        switchScope(true);
        await flushMicrotasks();
        expect(original.isCurrent()).toBe(false);
        expect(original.optOut.apply()).toBe(false);
        expect(onUpdateFailure.mock.calls[1]![1].admit()).toBe(true);
        switchScope(false);
        await flushMicrotasks();
        const returned = onUpdateFailure.mock.calls[2]![1];
        expect(returned.isCurrent()).toBe(true);
        expect(returned.canPresent()).toBe(true);
        expect(returned.admit()).toBe(false);
        expect(returned.optOut.notice()).toBe("save-failed");
        expect(original.isCurrent()).toBe(false);
        expect(overlays.snapshot.updateRun).toEqual(FAILURE);
        expect(overlays.snapshot.updateRunAcknowledged).toBe(false);

        run = { ...FAILURE, runId: "new-failed-run", createdAtMs: 4_000, updatedAtMs: 4_000 };
        await overlays.refreshUpdateStatus();
        expect(onUpdateFailure.mock.calls[3]![1].admit()).toBe(true);
        overlays.dispose();
        run = FAILURE;
        overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
        await flushMicrotasks();
        expect(returned.isCurrent()).toBe(false);
        expect(onUpdateFailure.mock.calls[4]![1].admit()).toBe(true);
        expect(localStorage.getItem("openclaw:control-ui:update-triage-opt-out:v1")).toBeNull();
      } finally {
        save.mockRestore();
        overlays.dispose();
      }
    },
  );

  it("retains a declined run across reload and new tabs while a new run remains eligible", async () => {
    let run = FAILURE;
    const harness = updateRunHarness(async () => ({ lastRun: run }));
    const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
    let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      const admission = onUpdateFailure.mock.calls[0]![1];
      expect(admission.optOut.apply()).toBe(true);
      expect(admission.isCurrent()).toBe(true);
      expect(admission.admit()).toBe(false);
      expect(overlays.snapshot.updateRunAcknowledged).toBe(false);
      expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      for (const newTab of [false, true]) {
        overlays.dispose();
        if (newTab) {
          sessionStorage.clear();
        }
        overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
        await flushMicrotasks();
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      }
      run = { ...FAILURE, runId: "new-failed-run", createdAtMs: 4_000, updatedAtMs: 4_000 };
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      expect(onUpdateFailure.mock.calls[1]![1].admit()).toBe(true);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["saved in another tab", "unreadable history"])(
    "checks fresh browser intent at final admission after %s",
    async (boundary) => {
      const harness = updateRunHarness(async () => ({ lastRun: FAILURE }));
      const onUpdateFailure =
        vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        const admission = onUpdateFailure.mock.calls[0]![1];
        if (boundary === "saved in another tab") {
          createUpdateRunReceipts().recordTriageOptOut(
            gatewayCredentialScope(harness.gateway.connection.gatewayUrl),
            null,
            FAILURE.runId,
          );
        } else {
          localStorage.setItem("openclaw:control-ui:update-triage-opt-out:v1", "unreadable");
        }
        expect(admission.isCurrent()).toBe(true);
        expect(admission.admit()).toBe(false);
        expect(admission.optOut.notice()).toBe(
          boundary === "unreadable history" ? "history-unavailable" : null,
        );
        expect(sessionStorage.getItem("openclaw:control-ui:update:v1")).toBeNull();
      } finally {
        overlays.dispose();
      }
    },
  );

  it("presents a manual terminal failure after its admission request releases the interlock", async () => {
    const harness = updateRunHarness(async (method) => {
      if (method === "update.run") {
        return { runId: FAILURE.runId };
      }
      return method === "update.runs.get" ? { run: FAILURE } : {};
    });
    const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      await overlays.runUpdate();
      expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(onUpdateFailure.mock.calls[0]![1].admit()).toBe(true);
    } finally {
      overlays.dispose();
    }
  });

  it("carries the run failure once across events, status refreshes, access changes, and reload", async () => {
    let run = updateRunFixture();
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.runs.get" ? { run } : { lastRun: run },
    );
    const harness = updateRunHarness(request);
    const admin = harness.gateway.snapshot.hello;
    const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
    let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      expect(onUpdateFailure).not.toHaveBeenCalled();
      run = FAILURE;
      harness.emitEvent("update.run.changed", run);
      await flushMicrotasks();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
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
      expect(admission.admit()).toBe(true);
      expect(admission.admit()).toBe(false);
      harness.emitEvent("update.run.changed", run);
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(admission.isCurrent()).toBe(false);
      harness.update({ hello: admin });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      overlays.dispose();
      overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["Gateway", "profile"] as const)(
    "scopes a consumed diagnostic to its %s across switching and reload",
    async (boundary) => {
      const request = vi.fn<RequestFn>(async () => ({ lastRun: FAILURE }));
      const harness = updateRunHarness(request);
      const initialGateway = harness.gateway.connection.gatewayUrl;
      const admin = harness.gateway.snapshot.hello;
      const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>(
        (_failure, admission) => expect(admission.admit()).toBe(true),
      );
      let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      const switchScope = (other: boolean) => {
        harness.gateway.connection.gatewayUrl =
          boundary === "Gateway" && other ? "ws://other.test" : initialGateway;
        harness.update({ phase: "connecting", client: null, hello: null });
        harness.update({
          phase: "connected",
          client: client(request),
          hello: admin,
          selfUser:
            boundary === "profile" && other
              ? ({ id: "other" } as NonNullable<ApplicationGatewaySnapshot["selfUser"]>)
              : undefined,
        });
      };
      try {
        await flushMicrotasks();
        const admission = onUpdateFailure.mock.calls[0]![1];
        switchScope(true);
        await flushMicrotasks();
        expect(admission.isCurrent()).toBe(false);
        expect(admission.optOut.apply()).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
        switchScope(false);
        await flushMicrotasks();
        overlays.dispose();
        overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
        await flushMicrotasks();
        expect(overlays.snapshot.updateRun).toEqual(FAILURE);
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each(["run", "campaign"])(
    "retires a queued failure admission when a newer %s starts",
    async (source) => {
      let run = FAILURE;
      const request = vi.fn<RequestFn>(async () => ({ activeRun: run }));
      const harness = updateRunHarness(request);
      const onUpdateFailure =
        vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        const admission = onUpdateFailure.mock.calls[0]![1];
        run = updateRunFixture({
          runId: "00000000-0000-4000-8000-000000000002",
          createdAtMs: 4_000,
          updatedAtMs: 4_000,
          origin: { campaignId: CAMPAIGN.campaign.id },
        });
        if (source === "campaign") {
          harness.emitEvent("update.available", { schedule: CAMPAIGN });
          expect(overlays.snapshot.updateRunning).toBe(true);
          expect(overlays.snapshot.updateRun).toEqual(FAILURE);
          expect(admission.isCurrent()).toBe(false);
          expect(admission.admit()).toBe(false);
          await overlays.runUpdate();
          expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
        }
        harness.emitEvent("update.run.changed", run);
        await flushMicrotasks();
        expect(admission.isCurrent()).toBe(false);
        expect(admission.admit()).toBe(false);
        expect(overlays.snapshot.updateRun).toEqual(run);
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(onUpdateFailure).toHaveBeenCalledOnce();
      } finally {
        overlays.dispose();
      }
    },
  );

  it("reports a preparation failure without dispatching or diagnosing an update", async () => {
    const previous = updateRunFixture({
      status: "succeeded",
      phase: "finished",
      finishedAtMs: 3_000,
    });
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status" ? { lastRun: previous } : {},
    );
    const harness = updateRunHarness(request);
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, {
      onUpdateFailure,
      drainConfigWrites: async () => {
        throw new Error("Config preparation failed");
      },
    });
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(previous);
      await overlays.runUpdate();
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("Config preparation failed");
      expect(onUpdateFailure).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  });

  it.each(["running", "succeeded", "skipped"] as const)(
    "does not diagnose a %s run",
    async (status) => {
      const run = updateRunFixture({
        status,
        phase: status === "running" ? "verifying" : "finished",
      });
      const harness = updateRunHarness(async () => ({ lastRun: run }));
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        expect(onUpdateFailure).not.toHaveBeenCalled();
      } finally {
        overlays.dispose();
      }
    },
  );

  it("still presents a retained pre-ledger failure on upgrade", async () => {
    const harness = updateRunHarness(async () => ({
      sentinel: { kind: "update", status: "error", ts: 1_000, stats: { reason: "build-failed" } },
    }));
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
      expect(onUpdateFailure).toHaveBeenCalledOnce();
    } finally {
      overlays.dispose();
    }
  });

  it("does not turn failed status or hold requests into a failed update", async () => {
    let unavailable = false;
    const harness = updateRunHarness(async (method) => {
      if (unavailable && (method === "update.status" || method === "update.hold")) {
        throw new Error("Unavailable");
      }
      return {};
    });
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
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
    } finally {
      overlays.dispose();
    }
  });
  it.each([
    { code: "INVALID_REQUEST", message: "Invalid update request parameters" },
    { code: "INVALID_REQUEST", message: "Missing operator.admin scope" },
    { code: "UNAVAILABLE", message: "Gateway restart admission is unavailable" },
  ])("preserves the sent rejection $message over historical success", async (failure) => {
    const previous = updateRunFixture({
      status: "succeeded",
      phase: "finished",
      finishedAtMs: 3_000,
    });
    const request = vi.fn<RequestFn>(async (method, _params, options) => {
      if (method === "update.run") {
        options?.onSent?.();
        throw new GatewayRequestError(failure);
      }
      return method === "update.status" ? { lastRun: previous } : {};
    });
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(previous);
      await overlays.runUpdate();
      expect(overlays.snapshot.updateStatusBanner?.text).toContain(failure.message);
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(overlays.snapshot.updateRunning).toBe(false);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["recorded:1000", "stable-handoff"])(
    "does not replay the stable v2026.9.1 consumed diagnostic %s after reload",
    async (id) => {
      const scope = gatewayCredentialScope("ws://gateway.test");
      const stored = JSON.stringify({ triaged: [JSON.stringify([scope, null, id])] });
      sessionStorage.setItem("openclaw:control-ui:update:v1", stored);
      const harness = updateRunHarness(async () => ({
        sentinel: {
          kind: "update",
          status: "error",
          ts: 1_000,
          stats: { reason: "build-failed", ...(id === "stable-handoff" ? { handoffId: id } : {}) },
        },
      }));
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
        expect(onUpdateFailure).not.toHaveBeenCalled();
        expect(sessionStorage.getItem("openclaw:control-ui:update:v1")).toBe(stored);
      } finally {
        overlays.dispose();
      }
    },
  );
});
