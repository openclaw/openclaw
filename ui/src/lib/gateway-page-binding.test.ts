// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/context.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { GatewayPageBinding } from "./gateway-page-binding.ts";

function snapshot(
  client: GatewayBrowserClient | null,
  phase: ApplicationGatewaySnapshot["phase"],
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

describe("GatewayPageBinding", () => {
  it("notifies availability recovery once without changing the connection epoch", () => {
    const client = {} as GatewayBrowserClient;
    const connected = snapshot(client, "connected");
    const source = createGateway({ ...connected, suspensionPhase: "draining" });
    const onSnapshot = vi.fn();
    const ensureInitialData = vi.fn();
    const controller = new GatewayPageBinding(vi.fn(), {
      getGateway: () => source.gateway,
      onSnapshot,
      ensureInitialData,
    });
    controller.connect();
    const scope = controller.capture();
    source.publish({ ...connected, suspensionPhase: "accepting" });
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ becameAvailable: true, becameConnected: false }),
    );
    source.publish({ ...connected, suspensionPhase: "accepting", assistantAgentId: "main" });
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ becameAvailable: false }),
    );
    source.publish({ ...connected, restartPending: true });
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ becameAvailable: false }),
    );
    source.publish({ ...connected, restartPending: false });
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ becameAvailable: true, becameConnected: false }),
    );
    expect(scope && controller.isCurrent(scope)).toBe(true);
    expect(ensureInitialData).toHaveBeenCalledTimes(1);
  });

  it("binds the current source and retires work across same-client reconnects", () => {
    const client = {} as GatewayBrowserClient;
    const source = createGateway(snapshot(client, "connected"));
    const identityChanges = vi.fn();
    const invalidations = vi.fn();
    const ensureInitialData = vi.fn();
    const controller = new GatewayPageBinding(vi.fn(), {
      getGateway: () => source.gateway,
      onIdentityChange: identityChanges,
      invalidateRequests: invalidations,
      ensureInitialData,
    });

    controller.connect();
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
    const client = {} as GatewayBrowserClient;
    const first = createGateway(snapshot(client, "connected"));
    const second = createGateway(snapshot(client, "connected"));
    let gateway = first.gateway;
    const identityChanges = vi.fn();
    const controller = new GatewayPageBinding(vi.fn(), {
      getGateway: () => gateway,
      onIdentityChange: identityChanges,
    });
    controller.connect();
    const scope = controller.capture();

    gateway = second.gateway;
    controller.refresh();

    expect(scope && controller.isCurrent(scope)).toBe(false);
    expect(identityChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceChanged: true, identityChanged: true }),
    );
  });

  it.each(["account", "recovery scope"] as const)(
    "retains identity through profile hydration but retires the same client on a new %s",
    (boundary) => {
      const client = {} as GatewayBrowserClient;
      const hello = gatewayHelloForMethods(["sessions.list"]);
      hello.auth = { ...hello.auth, recoveryScope: "scope-alice" };
      const connected = {
        ...snapshot(client, "connected"),
        hello,
        selfUser: { id: "alice", name: "Alice" },
      };
      const source = createGateway(connected);
      const identityChanges = vi.fn();
      const invalidations = vi.fn();
      const ensureInitialData = vi.fn();
      const controller = new GatewayPageBinding(vi.fn(), {
        getGateway: () => source.gateway,
        onIdentityChange: identityChanges,
        invalidateRequests: invalidations,
        ensureInitialData,
      });
      controller.connect();
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

  it("checks route data by exact source and snapshot identity", () => {
    const current = createGateway(snapshot({} as GatewayBrowserClient, "connected"));
    const controller = new GatewayPageBinding(vi.fn(), {
      getGateway: () => current.gateway,
    });
    controller.connect();

    expect(
      controller.isRouteDataCurrent({
        gateway: current.gateway,
        gatewaySnapshot: current.gateway.snapshot,
      }),
    ).toBe(true);
    expect(
      controller.isRouteDataCurrent({
        gateway: current.gateway,
        gatewaySnapshot: { ...current.gateway.snapshot },
      }),
    ).toBe(false);
  });

  it("keeps route data current through metadata clones within one hello epoch", () => {
    const client = {} as GatewayBrowserClient;
    const hello = {} as NonNullable<ApplicationGatewaySnapshot["hello"]>;
    const firstSnapshot = { ...snapshot(client, "connected"), hello };
    const current = createGateway(firstSnapshot);
    const controller = new GatewayPageBinding(vi.fn(), {
      getGateway: () => current.gateway,
    });
    controller.connect();
    const routeData = {
      gateway: current.gateway,
      gatewaySnapshot: firstSnapshot,
    };

    current.publish({ ...firstSnapshot });
    expect(controller.isRouteDataCurrent(routeData)).toBe(true);

    current.publish({
      ...firstSnapshot,
      hello: {} as NonNullable<ApplicationGatewaySnapshot["hello"]>,
    });
    expect(controller.isRouteDataCurrent(routeData)).toBe(false);
  });

  it("can reconnect after disposal", () => {
    const current = createGateway(snapshot({} as GatewayBrowserClient, "connected"));
    const identityChanges = vi.fn();
    const controller = new GatewayPageBinding(vi.fn(), {
      getGateway: () => current.gateway,
      onIdentityChange: identityChanges,
    });
    controller.connect();
    const stale = controller.capture();

    controller.dispose();
    expect(stale && controller.isCurrent(stale)).toBe(false);
    expect(controller.capture()).toBeNull();
    expect(identityChanges).not.toHaveBeenCalled();

    current.publish(snapshot({} as GatewayBrowserClient, "connected"));
    expect(controller.capture()).toBeNull();
    expect(identityChanges).not.toHaveBeenCalled();

    controller.connect();
    expect(controller.capture()).not.toBeNull();
    expect(identityChanges).toHaveBeenCalledTimes(1);
  });
});
