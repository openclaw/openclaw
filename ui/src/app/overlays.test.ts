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
type Overlays = ReturnType<typeof createApplicationOverlays>;
const ownedOverlays = new Set<Overlays>();
function ownOverlays(...args: Parameters<typeof createApplicationOverlays>) {
  const overlays = createApplicationOverlays(...args);
  ownedOverlays.add(overlays);
  return overlays;
}
afterEach(() => {
  for (const overlays of ownedOverlays) {
    overlays.dispose();
  }
  ownedOverlays.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const successfulRequest = () =>
  vi.fn<RequestFn>(async (method) => (method.endsWith(".list") ? [] : { ok: true }));
const isDecision = (method: string) => !method.endsWith(".list");
const reviewOnly = "Review only. Sign in with approval access to record a decision.";
const failed = "Approval failed: gateway unavailable";
function pendingRequests(matches: string | ((method: string) => boolean)) {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let reads = 0;
  const request = vi.fn<RequestFn>((method) =>
    (typeof matches === "string" ? method === matches : matches(method))
      ? ++reads === 1
        ? first.promise
        : second.promise
      : Promise.resolve([]),
  );
  return { request, first, second, count: () => reads };
}
function fixture(
  request: RequestFn,
  scopes?: string[] | null,
  initial: Partial<ApplicationGatewaySnapshot> = {},
  hooks: Parameters<typeof createApplicationOverlays>[1] = {},
) {
  const harness = createGatewayHarness(client(request));
  if (scopes === null) {
    harness.update({ hello: null });
  } else if (scopes) {
    harness.setScopes(scopes);
  }
  harness.update(initial);
  const overlays = ownOverlays(harness.gateway, hooks);
  return { harness, overlays };
}

function expectQueue(overlays: Overlays, ...ids: string[]) {
  expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(ids);
}
function expectError(overlays: Overlays, id: string, text: string) {
  expect(overlays.snapshot.approvalErrors.get(id)).toBe(text);
}

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
    const overlays = ownOverlays(store.gateway);
    try {
      store.gateway.connect({ gatewayUrl });
      store.current().testOptions.onHello?.({
        ...GATEWAY_STORE_TEST_HELLO,
        server: { version: "1.0.0", buildId: "gateway-build", connId: "first" },
      });
      expect(store.gateway.snapshot.phase).toBe("connected");
      expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

      // A restart onto another package version stays a reconnect, not a refresh.
      store.current().testOptions.onClose?.({ code: 1012, reason: "restarting", willRetry: true });
      store.current().testOptions.onHello?.({
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
    const overlays = ownOverlays(harness.gateway, {
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
    const overlays = ownOverlays(harness.gateway);

    harness.update({
      client: gatewayClient,
      phase: "reload-required",
      hello: null,
    });

    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);
  });

  it("projects the store's stale-build fence until admission or a fresh client lifetime", () => {
    const gatewayClient = client(async () => []);
    const harness = createGatewayHarness(null, false);
    const overlays = ownOverlays(harness.gateway);
    const hello = { server: { version: "2.0.0" } } as ApplicationGatewaySnapshot["hello"];

    // The store fences a stale same-origin hello by publishing it without connecting.
    harness.update({ client: gatewayClient, phase: "reconnecting", hello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);
    harness.update({ phase: "reconnecting", hello: null });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);

    harness.update({ phase: "connected", hello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    harness.update({ phase: "reconnecting", hello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);
    harness.update({ phase: "offline", hello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);
    harness.update({ client: null, phase: "stopped", hello: null });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);
  });
});

describe("application approval overlays", () => {
  it.each(["account", "recovery scope", "access", "epoch"] as const)(
    "retires old approval reads when the same client's %s changes",
    async (boundary) => {
      const { request, first, second, count } = pendingRequests("exec.approval.list");
      const hello = {
        auth: { role: "operator", recoveryScope: "scope-first" },
      } as ApplicationGatewaySnapshot["hello"];
      const { harness, overlays } = fixture(
        request,
        boundary === "access" ? ["operator.approvals"] : undefined,
        {
          selfUser: { id: "first" },
          ...(boundary === "access" ? {} : { hello }),
          ...(boundary === "epoch" ? { phase: "stopped" } : {}),
        },
      );
      if (boundary === "epoch") {
        await flushMicrotasks();
        expect(request).not.toHaveBeenCalled();
        harness.update({ phase: "connected" });
        await flushMicrotasks();
        for (const method of [
          "exec.approval.list",
          "plugin.approval.list",
          "openclaw.approval.list",
        ]) {
          expect(request).toHaveBeenCalledWith(method, {});
        }
      }
      expect(count()).toBe(1);
      if (boundary === "account" || boundary === "recovery scope") {
        harness.emitApproval("protected-first", 1_000);
        expectQueue(overlays, "protected-first");
      }
      if (boundary === "account") {
        harness.update({ selfUser: { id: "second" } });
      } else if (boundary === "recovery scope") {
        harness.update({
          hello: {
            auth: { role: "operator", recoveryScope: "scope-second" },
          } as ApplicationGatewaySnapshot["hello"],
        });
      } else if (boundary === "access") {
        harness.setScopes(["operator.read"]);
        expectQueue(overlays);
        expect(count()).toBe(1);
        harness.setScopes(["operator.admin"]);
      } else {
        harness.update({ phase: "stopped" });
        expectQueue(overlays);
        harness.update({ phase: "connected" });
        await flushMicrotasks();
      }
      expectQueue(overlays);
      expect(count()).toBe(2);
      // Check both arrival orders: identity changes can finish the stale read first.
      if (boundary === "account" || boundary === "recovery scope") {
        first.resolve([approval("stale", 1_000)]);
        await flushMicrotasks();
        expectQueue(overlays);
      }
      second.resolve([approval("current", 2_000)]);
      await vi.waitFor(() => expectQueue(overlays, "current"));
      if (boundary === "access" || boundary === "epoch") {
        first.resolve([approval("stale", 1_000)]);
        await flushMicrotasks();
        expectQueue(overlays, "current");
      }
    },
  );

  it("retains approvals offline and retries partial reconnect lists until they recover", async () => {
    vi.useFakeTimers();
    let execReads = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method === "exec.approval.list") {
        execReads += 1;
        return execReads > 1 && execReads < 5
          ? Promise.reject(new Error("temporarily unavailable"))
          : Promise.resolve([approval(execReads === 1 ? "retained" : "fresh", 1_000)]);
      }
      return Promise.resolve([]);
    });
    const { harness, overlays } = fixture(request);
    const hello = harness.gateway.snapshot.hello;
    await flushMicrotasks();
    expectQueue(overlays, "retained");

    harness.update({ phase: "reconnecting", hello: null });
    expectQueue(overlays, "retained");
    expect(overlays.snapshot.approvalCanGrant).toBe(false);
    await overlays.decideApproval("allow-once", "retained");
    expect(request.mock.calls.some(([method]) => method.endsWith(".resolve"))).toBe(false);

    harness.update({ phase: "connected", hello });
    await flushMicrotasks();
    expectQueue(overlays, "retained");
    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(execReads).toBe(5);
    expectQueue(overlays, "fresh");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(execReads).toBe(5);

    harness.update({ phase: "reconnecting", client: client(request), hello: null });
    expectQueue(overlays);
  });

  it("cancels approval list recovery while disconnected or disposed", async () => {
    vi.useFakeTimers();
    const request = vi.fn<RequestFn>((method) =>
      method === "exec.approval.list"
        ? Promise.reject(new Error("temporarily unavailable"))
        : Promise.resolve([]),
    );
    const { harness, overlays } = fixture(request);
    await flushMicrotasks();
    harness.update({ phase: "reconnecting" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(request.mock.calls.filter(([method]) => method === "exec.approval.list")).toHaveLength(
      1,
    );

    harness.update({ phase: "connected" });
    await flushMicrotasks();
    overlays.dispose();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(request.mock.calls.filter(([method]) => method === "exec.approval.list")).toHaveLength(
      2,
    );
  });

  it("keeps no-auth approvals readable without granting resolution authority", async () => {
    const request = successfulRequest();
    const { harness, overlays } = fixture(request, null);
    await flushMicrotasks();

    harness.emitApproval("approval-review-only", 1_000);
    await overlays.decideApproval("allow-once", "approval-review-only");

    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expectQueue(overlays, "approval-review-only");
    expect(overlays.snapshot.approvalCanGrant).toBe(false);
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expectError(overlays, "approval-review-only", reviewOnly);
    expect(
      request.mock.calls.some(
        ([method]) => method === "exec.approval.resolve" || method === "approval.resolve",
      ),
    ).toBe(false);
  });

  it.each([
    { change: { hello: null }, error: reviewOnly },
    {
      change: { phase: "reconnecting" as const },
      error: "Connect to the Gateway to change sessions.",
    },
  ])("rejects a rendered action after an unpublished $change update", async ({ change, error }) => {
    const request = successfulRequest();
    const { harness, overlays } = fixture(request, ["operator.approvals"]);
    if ("hello" in change) {
      await flushMicrotasks();
    }
    harness.emitApproval("stale", 1_000);
    // The click can precede the subscriber consuming the new authority/connection.
    harness.replaceSnapshotWithoutPublishing(change);
    await overlays.decideApproval("allow-once", "stale");
    expectError(overlays, "stale", error);
    expect(request.mock.calls.some(([method]) => method === "exec.approval.resolve")).toBe(false);
  });

  it.each([
    { name: "read-only", scopes: ["operator.read"] },
    { name: "write-only", scopes: ["operator.write"] },
  ])("does not request or expose approvals for a $name operator", async ({ scopes }) => {
    const request = vi.fn<RequestFn>(() => Promise.resolve([]));
    const gatewayClient = client(request);
    const harness = createGatewayHarness(null, false);
    const overlays = ownOverlays(harness.gateway);

    harness.setScopes(scopes);
    harness.update({ client: gatewayClient, phase: "connected" });
    await flushMicrotasks();

    expect(request).not.toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).not.toHaveBeenCalledWith("plugin.approval.list", {});
    expect(request).not.toHaveBeenCalledWith("openclaw.approval.list", {});

    harness.emitApproval("hidden-approval", 1_000);
    expectQueue(overlays);
  });

  it("rejects a retained approval action after same-client approval access is revoked", async () => {
    const request = successfulRequest();
    const { harness, overlays } = fixture(request, ["operator.approvals"]);
    await flushMicrotasks();
    harness.emitApproval("approval-retired", 1_000);

    harness.setScopes(["operator.read"]);
    await overlays.decideApproval("allow-once", "approval-retired");

    expectQueue(overlays);
    expect(request.mock.calls.some(([method]) => method === "exec.approval.resolve")).toBe(false);
  });

  it.each(["review access", "grant only", "client"] as const)(
    "does not let a retired %s decision release its replacement",
    async (boundary) => {
      const { request: sequence, first, second } = pendingRequests(isDecision);
      const request =
        boundary === "client"
          ? vi.fn<RequestFn>((method) =>
              method.endsWith(".list") ? Promise.resolve([]) : first.promise,
            )
          : sequence;
      const { harness, overlays } = fixture(
        request,
        boundary === "client" ? undefined : ["operator.approvals"],
      );
      if (boundary !== "client") {
        await flushMicrotasks();
      }
      harness.emitApproval("stale", 1_000);
      const staleDecision = overlays.decideApproval("allow-once", "stale");
      if (boundary === "client") {
        harness.update({ client: null, phase: "stopped" });
        const replacement = client((method) =>
          method.endsWith(".list") ? Promise.resolve([]) : second.promise,
        );
        harness.update({ client: replacement, phase: "connected" });
        await Promise.resolve();
      } else if (boundary === "review access") {
        harness.setScopes(["operator.read"]);
        harness.setScopes(["operator.approvals"]);
        await flushMicrotasks();
      } else {
        harness.update({ hello: null });
        expect(overlays.snapshot).toMatchObject({ approvalBusy: false, approvalCanGrant: false });
        expectQueue(overlays, "stale");
        expectError(overlays, "stale", reviewOnly);
        harness.setScopes(["operator.approvals"]);
      }
      harness.emitApproval("current", 2_000);
      const currentDecision = overlays.decideApproval("deny", "current");
      expect(overlays.snapshot.approvalBusy).toBe(true);
      if (boundary === "grant only") {
        expect(overlays.snapshot.approvalCanGrant).toBe(true);
      }
      if (boundary === "client") {
        first.reject(new Error("gateway client stopped"));
      } else {
        first.resolve({ ok: true });
      }
      await staleDecision;
      expect(overlays.snapshot.approvalBusy).toBe(true);
      expectQueue(overlays, ...(boundary === "grant only" ? ["stale", "current"] : ["current"]));
      if (boundary === "client") {
        expect(overlays.snapshot.approvalErrors).toEqual(new Map());
      }
      second.resolve({ ok: true });
      await currentDecision;
      expect(overlays.snapshot.approvalBusy).toBe(false);
      expectQueue(overlays, ...(boundary === "grant only" ? ["stale"] : []));
      if (boundary === "grant only") {
        expectError(overlays, "stale", reviewOnly);
      }
    },
  );

  it("resolves OpenClaw changes through unified human approval", async () => {
    const request = successfulRequest();
    const { harness, overlays } = fixture(request);

    harness.emitSystemApproval("system-agent:1", 1_000);
    await overlays.decideApproval("allow-once");

    expect(request).toHaveBeenCalledWith("approval.resolve", {
      id: "system-agent:1",
      kind: "system-agent",
      decision: "allow-once",
    });
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
    const { overlays } = fixture(request);
    const projectedApproval = {
      ...approval("approval-projected", 1_000),
      kind: "exec" as const,
    };

    await overlays.decideApproval("allow-once", projectedApproval.id, projectedApproval);

    expectError(overlays, projectedApproval.id, failed);
    expect(overlays.snapshot.approvalBusy).toBe(false);

    await overlays.decideApproval("allow-once", projectedApproval.id, projectedApproval);

    expect(overlays.snapshot.approvalErrors.has(projectedApproval.id)).toBe(false);
  });

  it("keeps A's failure visible after deciding B successfully", async () => {
    const { request, first, second } = pendingRequests("exec.approval.resolve");
    const { harness, overlays } = fixture(request);

    harness.emitApproval("approval-a", 1_000);
    const firstDecision = overlays.decideApproval("allow-once", "approval-a");
    harness.emitApproval("approval-b", 2_000);
    first.reject(new Error("gateway unavailable"));
    await firstDecision;
    expectQueue(overlays, "approval-a", "approval-b");
    expectError(overlays, "approval-a", failed);
    expect(overlays.snapshot.approvalBusy).toBe(false);

    const secondDecision = overlays.decideApproval("deny", "approval-b");
    second.resolve({ ok: true });
    await secondDecision;

    expectQueue(overlays, "approval-a");
    expectError(overlays, "approval-a", failed);
  });

  it("does not dismiss a new approval when an old same-client decision settles", async () => {
    const oldResolve = deferred<unknown>();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : oldResolve.promise,
    );
    const { harness, overlays } = fixture(request);

    harness.emitApproval("approval-old", 1_000);
    const oldDecision = overlays.decideApproval("allow-once");
    harness.update({ phase: "stopped" });
    harness.update({ phase: "connected" });
    await flushMicrotasks();
    harness.emitApproval("approval-new", 2_000);

    oldResolve.resolve({ ok: true });
    await oldDecision;

    expectQueue(overlays, "approval-new");
    expect(overlays.snapshot.approvalBusy).toBe(false);
  });

  it("ignores a decision that settles after disposal", async () => {
    const resolveAttempt = deferred<unknown>();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
    );
    const { harness, overlays } = fixture(request);

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
  it("rejects an update request from a read-only operator", async () => {
    const request = vi.fn<RequestFn>(() => Promise.resolve({ ok: true }));
    const drainConfigWrites = vi.fn(async () => undefined);
    const { overlays } = fixture(request, ["operator.read"], {}, { drainConfigWrites });
    await overlays.runUpdate();
    expect(request.mock.calls.filter(([method]) => method === "update.run")).toEqual([]);
    expect(drainConfigWrites).not.toHaveBeenCalled();
    expect(overlays.snapshot.updateRunning).toBe(false);
  });

  it("drains config writes after suspending and before issuing update.run", async () => {
    const order: string[] = [];
    const request = vi.fn<RequestFn>().mockImplementation(async (method) => {
      order.push(method);
      return { ok: true, result: { status: "ok", after: { version: "2.0.0" } } };
    });
    const harness = createGatewayHarness(client(request));
    let updateRunningWhenDrained = false;
    harness.update({ sessionKey: "agent:main:originating-chat" });
    const overlays = ownOverlays(harness.gateway, {
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
  });
});
