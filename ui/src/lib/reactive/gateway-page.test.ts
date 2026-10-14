import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { useGatewayPage } from "./gateway-page.ts";

function snapshot(
  client: GatewayBrowserClient,
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

function source(initial: ApplicationGatewaySnapshot) {
  const fixture = createApplicationGateway(initial);
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const subscribe = fixture.gateway.subscribe;
  fixture.gateway.subscribe = (listener) => {
    listeners.add(listener);
    const unsubscribe = subscribe(listener);
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  };
  return { ...fixture, listeners };
}

function mountGateway(options: Parameters<typeof useGatewayPage>[0]) {
  let page!: ReturnType<typeof useGatewayPage>;
  const dispose = createRoot((stop) => {
    page = useGatewayPage(options);
    return stop;
  });
  onTestFinished(dispose);
  flush();
  return { page, dispose };
}

describe("Solid Gateway page lifetime", () => {
  it("retires requests synchronously on same-client reconnects and owner disposal", () => {
    const client = {} as GatewayBrowserClient;
    const current = snapshot(client);
    const gateway = source(current);
    const abort = new AbortController();
    const identityChanged = vi.fn();
    const initialData = vi.fn();
    const invalidate = vi.fn(() => abort.abort());
    const { page, dispose } = mountGateway({
      getGateway: () => gateway.gateway,
      onIdentityChange: identityChanged,
      invalidateRequests: invalidate,
      ensureInitialData: initialData,
    });
    const first = page.capture();
    expect(first).not.toBeNull();
    // The producer can reuse a mutable snapshot; previous transport facts stay separate.
    current.phase = "reconnecting";
    gateway.publish(current);
    expect(abort.signal.aborted).toBe(true);
    expect(first && page.isCurrent(first)).toBe(false);
    expect(page.capture()).toBeNull();

    current.phase = "connected";
    gateway.publish(current);
    const reconnected = page.capture();
    expect(reconnected).not.toBeNull();
    expect(initialData).toHaveBeenCalledTimes(2);
    expect(identityChanged).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(2);

    dispose();
    expect(gateway.listeners.size).toBe(0);
    expect(reconnected && page.isCurrent(reconnected)).toBe(false);
    expect(page.capture()).toBeNull();
    expect(page.snapshot).toBeNull();
    expect(invalidate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        identityChanged: false,
        snapshot: expect.objectContaining({ phase: "stopped" }),
      }),
    );
  });

  it("rebinds an equivalent replacement source and ignores the retired subscription", () => {
    const client = {} as GatewayBrowserClient;
    const first = source(snapshot(client));
    const second = source(snapshot(client));
    const [gateway, setGateway] = createSignal(first.gateway);
    const identityChanged = vi.fn();
    const invalidate = vi.fn();
    const { page } = mountGateway({
      getGateway: gateway,
      onIdentityChange: identityChanged,
      invalidateRequests: invalidate,
    });
    const previous = page.capture();
    setGateway(second.gateway);
    flush();
    expect(previous && page.isCurrent(previous)).toBe(false);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    expect(identityChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceChanged: true, identityChanged: true }),
    );
    const epoch = page.epoch;
    first.publish(snapshot(client, "reconnecting"));
    expect(page.epoch).toBe(epoch);
    expect(page.connected).toBe(true);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("accepts route metadata clones only within the same source and hello epoch", () => {
    const client = {} as GatewayBrowserClient;
    const hello = {} as NonNullable<ApplicationGatewaySnapshot["hello"]>;
    const initial = { ...snapshot(client), hello };
    const current = source(initial);
    const changed = vi.fn();
    const initialData = vi.fn();
    const { page } = mountGateway({
      getGateway: () => current.gateway,
      onSnapshot: changed,
      ensureInitialData: initialData,
    });
    const route = { gateway: current.gateway, gatewaySnapshot: initial };
    const scope = page.capture();
    current.publish({ ...initial, suspensionPhase: "draining" });
    current.publish({ ...initial, suspensionPhase: "accepting" });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ becameAvailable: true, becameConnected: false }),
    );
    expect(page.isRouteDataCurrent(route)).toBe(true);
    expect(scope && page.isCurrent(scope)).toBe(true);
    expect(initialData).toHaveBeenCalledOnce();
    expect(page.isRouteDataCurrent({ ...route, gateway: source(initial).gateway })).toBe(false);
    current.publish({ ...initial, hello: {} as NonNullable<ApplicationGatewaySnapshot["hello"]> });
    expect(page.isRouteDataCurrent(route)).toBe(false);
  });

  it("releases page-activation listeners with the Solid owner", () => {
    const activate = vi.fn();
    const gateway = source(snapshot({} as GatewayBrowserClient));
    const { dispose } = mountGateway({
      getGateway: () => gateway.gateway,
      onPageActivation: activate,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    globalThis.dispatchEvent(new Event("focus"));
    expect(activate).toHaveBeenCalledTimes(2);
    dispose();
    document.dispatchEvent(new Event("visibilitychange"));
    globalThis.dispatchEvent(new Event("focus"));
    expect(activate).toHaveBeenCalledTimes(2);
  });
});
