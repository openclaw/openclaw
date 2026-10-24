import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";
import { createApplicationOverlays } from "./overlays.ts";

export type RequestFn = (...args: Parameters<GatewayBrowserClient["request"]>) => Promise<unknown>;

export function approval(id: string, createdAtMs: number) {
  return {
    id,
    createdAtMs,
    expiresAtMs: Date.now() + 60_000,
    request: { command: `echo ${id}` },
  };
}

export function createGatewayHarness(
  initialClient: GatewayBrowserClient | null,
  initialConnected = initialClient !== null,
) {
  let snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    assistantAgentId: "main",
    client: initialClient,
    phase: initialConnected ? "connected" : "stopped",
    hello: { auth: { role: "operator" } } as ApplicationGatewaySnapshot["hello"],
    sessionKey: "main",
  });
  const snapshotListeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const connect = vi.fn();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://gateway.test", password: "", token: "", bootstrapToken: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    loadSelfProfile: async () => null,
    connect,
    defer: () => false,
    setSessionKey() {},
    start() {},
    stop() {},
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEventLog() {
      return () => {};
    },
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } satisfies ApplicationGateway;
  const emitEvent = (event: string, payload: unknown) => {
    const frame: GatewayEventFrame = { event, payload, type: "event" };
    for (const listener of eventListeners) {
      listener(frame);
    }
  };
  const update = (next: Partial<ApplicationGatewaySnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of snapshotListeners) {
      listener(snapshot);
    }
  };
  return {
    emitEvent,
    emitApproval(id: string, createdAtMs: number) {
      emitEvent("exec.approval.requested", approval(id, createdAtMs));
    },
    emitDevicePairRequested() {
      emitEvent("device.pair.requested", {});
    },
    emitSystemApproval(id: string, createdAtMs: number) {
      emitEvent("openclaw.approval.requested", {
        id,
        createdAtMs,
        expiresAtMs: Date.now() + 60_000,
        request: {
          title: "OpenClaw change",
          description: "Set gateway.port to 19001",
          command: "Set gateway.port to 19001",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
        },
      });
    },
    gateway,
    connect,
    replaceSnapshotWithoutPublishing(next: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...next };
    },
    update,
    setScopes(scopes: string[]) {
      update({
        hello: { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
      });
    },
  };
}

export function client(request: RequestFn): GatewayBrowserClient {
  return { request } as unknown as GatewayBrowserClient;
}

export function createOverlayHarness(request: RequestFn, scopes?: string[] | null) {
  const harness = createGatewayHarness(client(request));
  if (scopes === null) {
    harness.update({ hello: null });
  } else if (scopes) {
    harness.setScopes(scopes);
  }
  return { harness, overlays: createApplicationOverlays(harness.gateway) };
}

export async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setupResult(setupId: string, expiresAtMs = Date.now() + 60_000) {
  return {
    setupId,
    expiresAtMs,
    setupCode: `setup-code-${setupId}`,
    gatewayUrl: "wss://gateway.test",
    auth: "token",
    urlSource: "test",
    access: "full",
  } as const;
}

function pairingRequest(setup: () => unknown, fallback: unknown = []) {
  return vi.fn<RequestFn>(async (method) =>
    method === "device.pair.setupCode"
      ? setup()
      : method === "device.pair.list"
        ? { pending: [] }
        : fallback,
  );
}
function pairEvent(
  setupId: string,
  deviceId: string,
  deviceName?: string,
  access = "full",
  ts = 1,
) {
  return { setupId, deviceId, ...(deviceName === undefined ? {} : { deviceName }), access, ts };
}
function expectLifecycle(overlays: ReturnType<typeof createApplicationOverlays>, phase: string) {
  expect(overlays.snapshot.devicePairSetupLifecycle).toEqual({ phase, access: "full" });
}
function pairingFixture(request: RequestFn, scopes?: string[] | null) {
  const f = createOverlayHarness(request, scopes);
  return {
    ...f,
    complete: (...args: Parameters<typeof pairEvent>) =>
      f.harness.emitEvent("device.pair.setup.completed", pairEvent(...args)),
    uncertain: (...args: Parameters<typeof pairEvent>) =>
      f.harness.emitEvent("device.pair.setup.deliveryUncertain", pairEvent(...args)),
  };
}

export function registerOverlayPairingAccessTests() {
  it.each(["reconnect", "replacement", "access revocation", "dispose"] as const)(
    "does not open pairing when %s retires the pending interaction",
    async (boundary) => {
      const request = vi.fn<RequestFn>(() => Promise.resolve([]));
      const { harness, overlays } = createOverlayHarness(request, ["operator.admin"]);
      const opening = overlays.openDevicePairSetup();
      if (boundary === "reconnect") {
        harness.update({ phase: "reconnecting" });
        harness.update({ phase: "connected" });
      } else if (boundary === "replacement") {
        harness.update({ client: client(request) });
      } else if (boundary === "access revocation") {
        harness.setScopes(["operator.read"]);
      } else {
        overlays.dispose();
      }

      expect(await opening).toBe(false);
      expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
      expect(request.mock.calls.map(([method]) => method)).not.toContain("device.pair.list");
      overlays.dispose();
    },
  );

  it.each(["to-legacy", "to-scoped", "event"] as const)(
    "refreshes current pairing counts on %s",
    async (trigger) => {
      const first = deferred<{ pending: Array<{ id: string }> }>();
      let pending = [{ id: "first-pending" }];
      let requests = 0;
      const request = vi.fn<RequestFn>((method) => {
        if (method !== "device.pair.list") {
          return Promise.resolve([]);
        }
        return ++requests === 1 && trigger !== "event"
          ? first.promise
          : Promise.resolve({ pending });
      });
      const { harness, overlays } = createOverlayHarness(
        request,
        trigger === "to-legacy" ? ["operator.admin"] : null,
      );
      try {
        await overlays.openDevicePairSetup();
        if (trigger === "event") {
          await flushMicrotasks();
        }
        expect(overlays.snapshot.devicePairSetupOpen).toBe(true);
        expect(requests).toBe(1);
        if (trigger === "event") {
          expect(overlays.snapshot.devicePairPendingCount).toBe(1);
          expect(request).toHaveBeenCalledWith("device.pair.list", {});
        }
        pending = [{ id: "current-first" }, { id: "current-second" }];
        if (trigger === "to-legacy") {
          harness.update({ hello: null });
        } else if (trigger === "to-scoped") {
          harness.setScopes(["operator.admin"]);
        } else {
          harness.emitDevicePairRequested();
        }
        await flushMicrotasks();
        expect(overlays.snapshot).toMatchObject({
          devicePairSetupOpen: true,
          devicePairPendingCount: 2,
        });
        expect(requests).toBe(2);
        if (trigger !== "event") {
          first.resolve({ pending: [{ id: "retired" }] });
          await flushMicrotasks();
          expect(overlays.snapshot.devicePairPendingCount).toBe(2);
        } else {
          harness.setScopes(["operator.read"]);
          expect(overlays.snapshot).toMatchObject({
            devicePairSetupOpen: false,
            devicePairPendingCount: 0,
          });
          harness.emitDevicePairRequested();
          await flushMicrotasks();
          expect(requests).toBe(2);
        }
        expect(request.mock.calls.map(([method]) => method)).not.toContain("device.pair.setupCode");
      } finally {
        first.resolve({ pending: [] });
        overlays.dispose();
      }
    },
  );

  it("discards an in-flight setup credential after admin access becomes pairing-only", async () => {
    const setup = deferred<unknown>();
    const request = pairingRequest(() => setup.promise);
    const { harness, overlays } = createOverlayHarness(request, ["operator.admin"]);
    await overlays.openDevicePairSetup();
    const mintingSetup = overlays.refreshDevicePairSetup();
    expectLifecycle(overlays, "loading");

    harness.setScopes(["operator.pairing"]);
    expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
    expectLifecycle(overlays, "selection");

    setup.resolve(setupResult("retired-setup"));
    await mintingSetup;

    expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
    expectLifecycle(overlays, "selection");
    expect(
      request.mock.calls.filter(([method]) => method === "device.pair.setupCode"),
    ).toHaveLength(1);
    overlays.dispose();
  });

  it.each(["pairing", "write", "approvals", ""])(
    "blocks pairing setup for scope %s",
    async (scope) => {
      const request = vi.fn<RequestFn>(() => Promise.resolve({ pending: [] }));
      const { overlays } = createOverlayHarness(request, scope ? [`operator.${scope}`] : []);

      await expect(overlays.openDevicePairSetup()).resolves.toBe(false);
      await overlays.refreshDevicePairSetup();

      expect(request).not.toHaveBeenCalledWith("device.pair.list", {});
      expect(request.mock.calls.map(([method]) => method)).not.toContain("device.pair.setupCode");
      expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
      overlays.dispose();
    },
  );

  it("completes only the active setup from the dedicated event", async () => {
    let setupId = "setup-first";
    const request = pairingRequest(() => setupResult(setupId));
    const { harness, overlays, complete } = pairingFixture(request);

    await overlays.openDevicePairSetup();
    await overlays.refreshDevicePairSetup();
    expect(overlays.snapshot.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      setup: { setupId: "setup-first" },
    });

    harness.emitEvent("device.pair.resolved", {
      setupId: "setup-first",
      deviceId: "phone-first",
    });
    complete("setup-unrelated", "phone-unrelated", "Unrelated phone", "full", 1);
    expect(overlays.snapshot.devicePairSetupLifecycle.phase).toBe("waiting");

    setupId = "setup-second";
    await overlays.refreshDevicePairSetup();
    complete("setup-first", "phone-stale", "Stale phone", "full", 2);
    expect(overlays.snapshot.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      setup: { setupId: "setup-second" },
    });

    complete("setup-second", "phone-current", "  Operator's iPhone  ", "limited", 3);
    expect(overlays.snapshot.devicePairSetupLifecycle).toEqual({
      phase: "success",
      deviceName: "Operator's iPhone",
      access: "limited",
    });
    overlays.dispose();
  });

  it("surfaces delivery uncertainty only for the active setup", async () => {
    const request = pairingRequest(() => setupResult("setup-current"));
    const { overlays, uncertain } = pairingFixture(request);

    await overlays.openDevicePairSetup();
    await overlays.refreshDevicePairSetup();
    uncertain("setup-stale", "phone-stale", undefined, "full", 1);
    expect(overlays.snapshot.devicePairSetupLifecycle.phase).toBe("waiting");

    uncertain("setup-current", "phone-current", "Phone", "full", 2);
    expectLifecycle(overlays, "delivery-uncertain");
    overlays.dispose();
  });

  it.each(["reconnect", "access revocation", "dispose"] as const)(
    "retires the setup expiry timer on %s",
    async (boundary) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const request = pairingRequest(() => setupResult("setup-timer", 70_000), { pending: [] });
      const { harness, overlays } = createOverlayHarness(request, ["operator.admin"]);

      try {
        await overlays.openDevicePairSetup();
        await overlays.refreshDevicePairSetup();
        expect(vi.getTimerCount()).toBe(1);

        if (boundary === "reconnect") {
          harness.update({ client: client(request) });
        } else if (boundary === "access revocation") {
          harness.setScopes(["operator.pairing"]);
        } else {
          overlays.dispose();
        }

        expect(vi.getTimerCount()).toBe(0);
        if (boundary !== "dispose") {
          expectLifecycle(overlays, "selection");
        }
      } finally {
        overlays.dispose();
        vi.useRealTimers();
      }
    },
  );
}
