// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/context.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { GatewayPageBinding } from "./gateway-page-binding.ts";

function snapshot(
  client: GatewayBrowserClient | null = {} as GatewayBrowserClient,
  phase: ApplicationGatewaySnapshot["phase"] = "connected",
): ApplicationGatewaySnapshot {
  return {
    client,
    phase,
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
}

function createGateway(initial: ApplicationGatewaySnapshot) {
  let current = initial;
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return current;
    },
    subscribe(listener: (value: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    publish(next: ApplicationGatewaySnapshot) {
      current = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}

function bind(source = createGateway(snapshot()), getGateway = () => source.gateway) {
  const identityChanges = vi.fn();
  const invalidations = vi.fn();
  const ensureInitialData = vi.fn();
  const onSnapshot = vi.fn();
  const controller = new GatewayPageBinding(vi.fn(), {
    getGateway,
    onIdentityChange: identityChanges,
    invalidateRequests: invalidations,
    ensureInitialData,
    onSnapshot,
  });
  controller.connect();
  return { source, controller, identityChanges, invalidations, ensureInitialData, onSnapshot };
}

describe("GatewayPageBinding", () => {
  it("notifies availability recovery once without changing the connection epoch", () => {
    const connected = snapshot();
    const source = createGateway({ ...connected, suspensionPhase: "draining" });
    const { controller, onSnapshot, ensureInitialData } = bind(source);
    const scope = controller.capture();
    source.publish({ ...connected, suspensionPhase: "accepting" });
    source.publish({ ...connected, suspensionPhase: "accepting", assistantAgentId: "main" });
    source.publish({ ...connected, restartPending: true });
    source.publish({ ...connected, restartPending: false });
    expect(onSnapshot.mock.calls.slice(1).map(([change]) => change)).toMatchObject([
      { becameAvailable: true, becameConnected: false },
      { becameAvailable: false },
      { becameAvailable: false },
      { becameAvailable: true, becameConnected: false },
    ]);
    expect(scope && controller.isCurrent(scope)).toBe(true);
    expect(ensureInitialData).toHaveBeenCalledTimes(1);
  });

  it("binds the current source and retires work across same-client reconnects", () => {
    const { source, controller, identityChanges, invalidations, ensureInitialData } = bind();
    const client = source.gateway.snapshot.client;
    const first = controller.capture();
    expect(controller.client).toBe(client);
    expect(controller.connected).toBe(true);
    expect(first).not.toBeNull();

    source.publish(snapshot(client, "reconnecting"));
    expect(first && controller.isCurrent(first)).toBe(false);
    expect(controller.capture()).toBeNull();

    source.publish(snapshot(client, "connected"));
    expect(controller.capture()).not.toBeNull();
    expect(identityChanges).not.toHaveBeenCalled();
    expect(invalidations).toHaveBeenCalledTimes(2);
    expect(ensureInitialData).toHaveBeenCalledTimes(2);
  });

  it("treats an equivalent replacement source as a new identity", () => {
    let source = createGateway(snapshot());
    const { controller, identityChanges } = bind(source, () => source.gateway);
    const scope = controller.capture();
    source = createGateway(source.gateway.snapshot);
    controller.refresh();
    expect(scope && controller.isCurrent(scope)).toBe(false);
    expect(identityChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceChanged: true, identityChanged: true }),
    );
  });

  it.each(["account", "recovery scope"] as const)(
    "retains identity through profile hydration but retires the same client on a new %s",
    (boundary) => {
      const hello = gatewayHelloForMethods(["sessions.list"]);
      hello.auth = { ...hello.auth, recoveryScope: "scope-alice" };
      const connected = {
        ...snapshot(),
        hello,
        selfUser: { id: "alice", name: "Alice" },
      };
      const source = createGateway(connected);
      const { controller, identityChanges, invalidations, ensureInitialData } = bind(source);
      source.publish({ ...connected, phase: "reconnecting", hello: null, selfUser: undefined });
      source.publish({ ...connected, selfUser: undefined });
      source.publish(connected);
      expect(identityChanges).not.toHaveBeenCalled();
      expect(invalidations).toHaveBeenCalledTimes(2);
      const stale = controller.capture();

      source.publish({
        ...connected,
        ...(boundary === "account"
          ? { selfUser: { id: "bob", name: "Bob" } }
          : { hello: { ...hello, auth: { ...hello.auth, recoveryScope: "scope-bob" } } }),
      });

      expect(stale && controller.isCurrent(stale)).toBe(false);
      expect(identityChanges).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ identityChanged: true, clientChanged: false }),
      );
      expect(invalidations).toHaveBeenCalledTimes(3);
      expect(ensureInitialData).toHaveBeenCalledTimes(3);
      controller.dispose();
    },
  );

  it.each([null, gatewayHelloForMethods([])])(
    "checks route snapshot identity with hello %j",
    (hello) => {
      const firstSnapshot = { ...snapshot(), hello };
      const current = createGateway(firstSnapshot);
      const { controller } = bind(current);
      const routeData = { gateway: current.gateway, gatewaySnapshot: firstSnapshot };
      expect(controller.isRouteDataCurrent(routeData)).toBe(true);
      expect(
        controller.isRouteDataCurrent({ ...routeData, gatewaySnapshot: { ...firstSnapshot } }),
      ).toBe(hello !== null);
      current.publish({ ...firstSnapshot });
      expect(controller.isRouteDataCurrent(routeData)).toBe(hello !== null);
      current.publish({ ...firstSnapshot, hello: gatewayHelloForMethods([]) });
      expect(controller.isRouteDataCurrent(routeData)).toBe(false);
    },
  );

  it("can reconnect after disposal", () => {
    const { source, controller, identityChanges } = bind();
    const stale = controller.capture();

    controller.dispose();
    expect(stale && controller.isCurrent(stale)).toBe(false);
    expect(controller.capture()).toBeNull();
    expect(identityChanges).not.toHaveBeenCalled();

    source.publish(snapshot());
    expect(controller.capture()).toBeNull();
    expect(identityChanges).not.toHaveBeenCalled();

    controller.connect();
    expect(controller.capture()).not.toBeNull();
    expect(identityChanges).toHaveBeenCalledTimes(1);
  });
});
