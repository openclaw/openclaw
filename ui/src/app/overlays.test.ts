// @vitest-environment node
// Control UI tests cover application-owned overlay races.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  approval,
  client,
  createGatewayHarness,
  flushMicrotasks,
  registerOverlayPairingAccessTests,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

vi.mock("../build-info.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../build-info.ts")>()),
  CONTROL_UI_BUILD_INFO: { version: "1.0.0", buildId: "test" },
  controlUiBuildDiffersFrom: (identity: {
    version?: string | null;
    buildId?: string | null;
    controlUiBuildSource?: "bundled" | "configured";
  }) =>
    identity.controlUiBuildSource === "configured"
      ? false
      : Boolean(
          identity.buildId?.trim()
            ? identity.buildId.trim() !== "test"
            : identity.version?.trim() && identity.version.trim() !== "1.0.0",
        ),
}));
vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Control UI refresh nudge", () => {
  it.each([
    { surface: "a hosted Control UI", page: "https://control.example/", devProxy: false },
    { surface: "the ui:dev proxy", page: "http://localhost:5173/", devProxy: true },
  ])("never asks $surface to reload for a cross-origin Gateway build", ({ page, devProxy }) => {
    const gatewayUrl = "ws://127.0.0.1:18789";
    stubGatewayStoreTestGlobals();
    // Reloading refetches this origin's build, never the dialed Gateway's.
    vi.stubGlobal("location", new URL(page));
    if (devProxy) {
      vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", {
        gatewayUrl,
        proxyPath: "/__openclaw_dev_gateway__/fixture",
      });
    }
    const store = createGatewayStoreTestStore();
    const overlays = createApplicationOverlays(store.gateway);
    try {
      store.gateway.connect({ gatewayUrl });
      store.current().opts.onHello?.({
        ...GATEWAY_STORE_TEST_HELLO,
        server: { version: "1.0.0", buildId: "gateway-build", connId: "first" },
      });
      expect(store.gateway.snapshot.phase).toBe("connected");
      expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

      // A restart onto another package version stays a reconnect, not a refresh.
      store.current().opts.onClose?.({ code: 1012, reason: "restarting", willRetry: true });
      store.current().opts.onHello?.({
        ...GATEWAY_STORE_TEST_HELLO,
        server: { version: "2.0.0", connId: "restarted" },
      });
      expect(store.gateway.snapshot.phase).toBe("connected");
      expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);
    } finally {
      overlays.dispose();
      store.gateway.stop();
      vi.unstubAllGlobals();
    }
  });

  it("runs automatic connection refreshes through the bootstrap coordinator", async () => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(method === "exec.approval.list" ? [] : {}),
    );
    const coordinator = createConnectionBootstrapCoordinator();
    const run = vi.spyOn(coordinator, "run");
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway, {
      connectionBootstrap: coordinator,
    });

    const gatewayClient = client(request);
    harness.update({ client: gatewayClient, phase: "connected" });
    await flushMicrotasks();

    expect(run).toHaveBeenCalledWith("approvals", expect.any(Function));
    expect(run).toHaveBeenCalledWith("update-run", expect.any(Function));
    expect(request).not.toHaveBeenCalled();
    coordinator.synchronize({ client: gatewayClient, connected: true });
    await flushMicrotasks();
    expect(request).toHaveBeenCalled();
    overlays.dispose();
    coordinator.reset();
  });

  it("flags a terminal build rejection without requiring a hello", () => {
    const gatewayClient = client(async () => []);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.update({
      client: gatewayClient,
      phase: "reload-required",
      hello: null,
    });

    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);
    overlays.dispose();
  });

  it("projects the store's stale-build fence until admission or a fresh client lifetime", () => {
    const gatewayClient = client(async () => []);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    const hello = { server: { version: "2.0.0" } } as ApplicationGatewaySnapshot["hello"];

    // The store fences a stale same-origin hello by publishing it without connecting.
    harness.update({ client: gatewayClient, phase: "reconnecting", hello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);
    harness.update({ phase: "reconnecting", hello: null });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);

    harness.update({ phase: "connected", hello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    harness.update({ phase: "reconnecting", hello });
    harness.update({ client: null, phase: "stopped", hello: null });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    overlays.dispose();
  });
});

describe("application approval overlays", () => {
  it("keeps no-auth approvals readable without granting resolution authority", async () => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(method.endsWith(".list") ? [] : { ok: true }),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({ hello: null });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();

    harness.emitApproval("approval-review-only", 1_000);
    await overlays.decideApproval("allow-once", "approval-review-only");

    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-review-only",
    ]);
    expect(overlays.snapshot.approvalCanGrant).toBe(false);
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalErrors.get("approval-review-only")).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    expect(
      request.mock.calls.some(
        ([method]) => method === "exec.approval.resolve" || method === "approval.resolve",
      ),
    ).toBe(false);
    overlays.dispose();
  });

  it("surfaces a stale decision dispatched after grant revocation", async () => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(method.endsWith(".list") ? [] : { ok: true }),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();
    harness.emitApproval("approval-stale-action", 1_000);

    // A rendered action can dispatch before the overlay subscriber consumes
    // the snapshot that revokes its grant.
    harness.replaceSnapshotWithoutPublishing({ hello: null });
    await overlays.decideApproval("allow-once", "approval-stale-action");

    expect(overlays.snapshot.approvalErrors.get("approval-stale-action")).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    expect(request.mock.calls.some(([method]) => method === "exec.approval.resolve")).toBe(false);
    overlays.dispose();
  });

  it.each([
    { name: "read-only", scopes: ["operator.read"] },
    { name: "write-only", scopes: ["operator.write"] },
  ])("does not request or expose approvals for a $name operator", async ({ scopes }) => {
    const request = vi.fn<RequestFn>(() => Promise.resolve([]));
    const gatewayClient = client(request);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.update({
      client: gatewayClient,
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        auth: { role: "operator", scopes },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await flushMicrotasks();

    expect(request).not.toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).not.toHaveBeenCalledWith("plugin.approval.list", {});
    expect(request).not.toHaveBeenCalledWith("openclaw.approval.list", {});

    harness.emitApproval("hidden-approval", 1_000);
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    overlays.dispose();
  });

  it("discards pending approvals when access changes on the same client", async () => {
    const firstList = deferred<unknown>();
    const secondList = deferred<unknown>();
    let execListRequests = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method !== "exec.approval.list") {
        return Promise.resolve([]);
      }
      execListRequests += 1;
      return execListRequests === 1 ? firstList.promise : secondList.promise;
    });
    const gatewayClient = client(request);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.update({
      client: gatewayClient,
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    expect(execListRequests).toBe(1);

    harness.update({
      hello: {
        server: { version: "1.0.0" },
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    expect(execListRequests).toBe(1);

    harness.update({
      hello: {
        server: { version: "1.0.0" },
        auth: { role: "operator", scopes: ["operator.admin"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    expect(execListRequests).toBe(2);

    secondList.resolve([approval("approval-current", 2_000)]);
    await vi.waitFor(() => {
      expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
        "approval-current",
      ]);
    });

    firstList.resolve([approval("approval-stale", 1_000)]);
    await flushMicrotasks();
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-current"]);
    overlays.dispose();
  });

  it("rejects a retained approval action after same-client approval access is revoked", async () => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(method.endsWith(".list") ? [] : { ok: true }),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();
    harness.emitApproval("approval-retired", 1_000);

    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await overlays.decideApproval("allow-once", "approval-retired");

    expect(overlays.snapshot.approvalQueue).toEqual([]);
    expect(request.mock.calls.some(([method]) => method === "exec.approval.resolve")).toBe(false);
    overlays.dispose();
  });

  it("does not let a revoked approval decision release a restored decision", async () => {
    const staleResolution = deferred<unknown>();
    const currentResolution = deferred<unknown>();
    let resolutionCount = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      resolutionCount += 1;
      return resolutionCount === 1 ? staleResolution.promise : currentResolution.promise;
    });
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();
    harness.emitApproval("approval-stale", 1_000);
    const staleDecision = overlays.decideApproval("allow-once");

    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await flushMicrotasks();
    harness.emitApproval("approval-current", 2_000);
    const currentDecision = overlays.decideApproval("deny");

    staleResolution.resolve({ ok: true });
    await staleDecision;
    expect(overlays.snapshot.approvalBusy).toBe(true);
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-current"]);

    currentResolution.resolve({ ok: true });
    await currentDecision;
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    overlays.dispose();
  });

  it("retires a grant-only downgrade without clearing the readable approval queue", async () => {
    const staleResolution = deferred<unknown>();
    const currentResolution = deferred<unknown>();
    let resolutionCount = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      resolutionCount += 1;
      return resolutionCount === 1 ? staleResolution.promise : currentResolution.promise;
    });
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();
    harness.emitApproval("approval-stale-grant", 1_000);
    const staleDecision = overlays.decideApproval("allow-once", "approval-stale-grant");

    harness.update({ hello: null });
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalCanGrant).toBe(false);
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-stale-grant",
    ]);
    expect(overlays.snapshot.approvalErrors.get("approval-stale-grant")).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    harness.emitApproval("approval-current-grant", 2_000);
    const currentDecision = overlays.decideApproval("deny", "approval-current-grant");
    expect(overlays.snapshot.approvalCanGrant).toBe(true);

    staleResolution.resolve({ ok: true });
    await staleDecision;
    expect(overlays.snapshot.approvalBusy).toBe(true);
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-stale-grant",
      "approval-current-grant",
    ]);

    currentResolution.resolve({ ok: true });
    await currentDecision;
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-stale-grant",
    ]);
    expect(overlays.snapshot.approvalErrors.get("approval-stale-grant")).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    overlays.dispose();
  });

  it("resolves OpenClaw changes through unified human approval", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method.endsWith(".list") ? [] : { ok: true },
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitSystemApproval("system-agent:1", 1_000);
    await overlays.decideApproval("allow-once");

    expect(request).toHaveBeenCalledWith("approval.resolve", {
      id: "system-agent:1",
      kind: "system-agent",
      decision: "allow-once",
    });
    overlays.dispose();
  });

  it("reloads pending approvals for each connected epoch", async () => {
    const firstList = deferred<unknown>();
    const reconnectedList = deferred<unknown>();
    let execListRequests = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method !== "exec.approval.list") {
        return Promise.resolve([]);
      }
      execListRequests += 1;
      return execListRequests === 1 ? firstList.promise : reconnectedList.promise;
    });
    const gatewayClient = client(request);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.update({ client: gatewayClient, phase: "stopped" });
    await flushMicrotasks();
    expect(request).not.toHaveBeenCalled();

    harness.update({ phase: "connected" });
    await flushMicrotasks();
    expect(execListRequests).toBe(1);
    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).toHaveBeenCalledWith("plugin.approval.list", {});
    expect(request).toHaveBeenCalledWith("openclaw.approval.list", {});

    harness.update({ phase: "stopped" });
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    harness.update({ phase: "connected" });
    await flushMicrotasks();
    expect(execListRequests).toBe(2);

    reconnectedList.resolve([approval("approval-reconnected", 2_000)]);
    await vi.waitFor(() => {
      expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
        "approval-reconnected",
      ]);
    });

    firstList.resolve([approval("approval-stale", 1_000)]);
    await flushMicrotasks();
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-reconnected",
    ]);
    overlays.dispose();
  });

  it("keeps a resolve failure attached to its older request", async () => {
    const resolveAttempt = deferred<unknown>();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-active", 1_000);
    const decision = overlays.decideApproval("allow-once");
    harness.emitApproval("approval-newer", 2_000);
    resolveAttempt.reject(new Error("gateway unavailable"));
    await decision;

    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-active",
      "approval-newer",
    ]);
    expect(overlays.snapshot.approvalErrors.get("approval-active")).toBe(
      "Approval failed: gateway unavailable",
    );
    expect(overlays.snapshot.approvalBusy).toBe(false);
    overlays.dispose();
  });

  it("keeps a projected approval's resolve failure visible", async () => {
    let resolveAttempts = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method !== "exec.approval.resolve") {
        return Promise.resolve([]);
      }
      resolveAttempts += 1;
      return resolveAttempts === 1
        ? Promise.reject(new Error("gateway unavailable"))
        : Promise.resolve({ ok: true });
    });
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);
    const projectedApproval = {
      ...approval("approval-projected", 1_000),
      kind: "exec" as const,
    };

    await overlays.decideApproval("allow-once", projectedApproval.id, projectedApproval);

    expect(overlays.snapshot.approvalErrors.get(projectedApproval.id)).toBe(
      "Approval failed: gateway unavailable",
    );
    expect(overlays.snapshot.approvalBusy).toBe(false);

    await overlays.decideApproval("allow-once", projectedApproval.id, projectedApproval);

    expect(overlays.snapshot.approvalErrors.has(projectedApproval.id)).toBe(false);
    overlays.dispose();
  });

  it("surfaces a connection error when a rendered approval races a disconnect", async () => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(method.endsWith(".list") ? [] : { ok: true }),
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);
    harness.emitApproval("approval-disconnected", 1_000);

    // The rendered modal can dispatch its click before Lit consumes the
    // Gateway snapshot notification that removes the stale card.
    harness.replaceSnapshotWithoutPublishing({ phase: "reconnecting" });
    await overlays.decideApproval("allow-once", "approval-disconnected");

    expect(overlays.snapshot.approvalErrors.get("approval-disconnected")).toBe(
      "Connect to the Gateway to change sessions.",
    );
    expect(request).not.toHaveBeenCalledWith("exec.approval.resolve", expect.anything());
    overlays.dispose();
  });

  it("keeps A's failure visible after deciding B successfully", async () => {
    const firstResolve = deferred<unknown>();
    const secondResolve = deferred<unknown>();
    let resolveCalls = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method !== "exec.approval.resolve") {
        return Promise.resolve([]);
      }
      resolveCalls += 1;
      return resolveCalls === 1 ? firstResolve.promise : secondResolve.promise;
    });
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-a", 1_000);
    harness.emitApproval("approval-b", 2_000);
    const firstDecision = overlays.decideApproval("allow-once", "approval-a");
    firstResolve.reject(new Error("gateway unavailable"));
    await firstDecision;
    expect(overlays.snapshot.approvalErrors.get("approval-a")).toBe(
      "Approval failed: gateway unavailable",
    );

    const secondDecision = overlays.decideApproval("deny", "approval-b");
    secondResolve.resolve({ ok: true });
    await secondDecision;

    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-a"]);
    expect(overlays.snapshot.approvalErrors.get("approval-a")).toBe(
      "Approval failed: gateway unavailable",
    );
    overlays.dispose();
  });

  it("does not release a new client's busy state when an old resolve settles", async () => {
    const oldResolve = deferred<unknown>();
    const oldRequest = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : oldResolve.promise,
    );
    const harness = createGatewayHarness(client(oldRequest));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-old", 1_000);
    const oldDecision = overlays.decideApproval("allow-once");
    harness.update({ client: null, phase: "stopped" });

    const newResolve = deferred<unknown>();
    const newClient = client((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : newResolve.promise,
    );
    harness.update({ client: newClient, phase: "connected" });
    await Promise.resolve();
    harness.emitApproval("approval-new", 2_000);
    const newDecision = overlays.decideApproval("deny");
    expect(overlays.snapshot.approvalBusy).toBe(true);

    oldResolve.reject(new Error("gateway client stopped"));
    await oldDecision;
    expect(overlays.snapshot.approvalBusy).toBe(true);
    expect(overlays.snapshot.approvalErrors).toEqual(new Map());

    newResolve.resolve({ ok: true });
    await newDecision;
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    overlays.dispose();
  });

  it("does not dismiss a new approval when an old same-client decision settles", async () => {
    const oldResolve = deferred<unknown>();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : oldResolve.promise,
    );
    const gatewayClient = client(request);
    const harness = createGatewayHarness(gatewayClient);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-old", 1_000);
    const oldDecision = overlays.decideApproval("allow-once");
    harness.update({ phase: "stopped" });
    harness.update({ phase: "connected" });
    await flushMicrotasks();
    harness.emitApproval("approval-new", 2_000);

    oldResolve.resolve({ ok: true });
    await oldDecision;

    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-new"]);
    expect(overlays.snapshot.approvalBusy).toBe(false);
    overlays.dispose();
  });

  it("ignores a decision that settles after disposal", async () => {
    const resolveAttempt = deferred<unknown>();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-active", 1_000);
    const decision = overlays.decideApproval("allow-once");
    overlays.dispose();
    resolveAttempt.reject(new Error("disposed"));
    await decision;

    expect(overlays.snapshot.approvalErrors).toEqual(new Map());
  });
});

registerOverlayPairingAccessTests();

describe("application update overlays", () => {
  it.each([{ name: "read-only", scopes: ["operator.read"] }])(
    "rejects an update request from a $name operator",
    async ({ scopes }) => {
      const request = vi.fn<RequestFn>(() => Promise.resolve({ ok: true }));
      const drainConfigWrites = vi.fn(async () => undefined);
      const harness = createGatewayHarness(client(request));
      harness.update({
        hello: { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
      });
      const overlays = createApplicationOverlays(harness.gateway, { drainConfigWrites });

      await overlays.runUpdate();

      expect(request.mock.calls.filter(([method]) => method === "update.run")).toEqual([]);
      expect(drainConfigWrites).not.toHaveBeenCalled();
      expect(overlays.snapshot.updateRunning).toBe(false);
      overlays.dispose();
    },
  );

  it("drains config writes after suspending and before issuing update.run", async () => {
    const order: string[] = [];
    const request = vi.fn<RequestFn>().mockImplementation(async (method) => {
      order.push(method);
      return { ok: true, result: { status: "ok", after: { version: "2.0.0" } } };
    });
    const harness = createGatewayHarness(client(request));
    let updateRunningWhenDrained = false;
    harness.update({ sessionKey: "agent:main:originating-chat" });
    const overlays = createApplicationOverlays(harness.gateway, {
      getActiveSessionKey: () => harness.gateway.snapshot.sessionKey,
      drainConfigWrites: async () => {
        order.push("drain");
        updateRunningWhenDrained = overlays.snapshot.updateRunning;
        harness.update({ sessionKey: "agent:main:another-chat" });
        await Promise.resolve();
      },
    });

    await overlays.runUpdate();

    expect(order.filter((entry) => entry === "drain" || entry === "update.run")).toEqual([
      "drain",
      "update.run",
    ]);
    // Suspension publishes first so no NEW write can start while draining.
    expect(updateRunningWhenDrained).toBe(true);
    expect(
      request.mock.calls.filter(([method]) => method === "update.run").map(([, params]) => params),
    ).toEqual([{ sessionKey: "agent:main:originating-chat" }]);
    overlays.dispose();
  });
});
