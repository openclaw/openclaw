import { createRoot, createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { useGatewayPage } from "./gateway-page.ts";

function source(overrides: Partial<ApplicationGatewaySnapshot> = {}) {
  const fixture = createApplicationGateway({
    ...createApplicationGateway().gateway.snapshot,
    client: {} as GatewayBrowserClient,
    phase: "connected",
    ...overrides,
  });
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

type PageOptions = Parameters<typeof useGatewayPage>[0];
function createGatewayFixture(getGateway: PageOptions["getGateway"], invalidateRequests = vi.fn()) {
  const callbacks = {
    onIdentityChange: vi.fn(),
    ensureInitialData: vi.fn(),
    onPageActivation: vi.fn(),
    invalidateRequests,
  };
  const mounted = createRoot((dispose) => ({
    page: useGatewayPage({ getGateway, ...callbacks }),
    dispose,
  }));
  onTestFinished(mounted.dispose);
  flush();
  return { ...mounted, ...callbacks };
}

function expectChange(callback: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(callback).toHaveBeenLastCalledWith(expect.objectContaining(fields));
}

it("retires requests synchronously on mutable same-client reconnects and owner disposal", () => {
  const gateway = source();
  const current = gateway.gateway.snapshot;
  const abort = new AbortController();
  const invalidate = vi.fn(() => abort.abort());
  const view = createGatewayFixture(() => gateway.gateway, invalidate);
  const { page, dispose } = view;
  const first = page.capture();
  expect(first).not.toBeNull();
  current.phase = "reconnecting";
  gateway.publish(current);
  expect(abort.signal.aborted).toBe(true);
  expect(first && page.isCurrent(first)).toBe(false);
  expect(page.capture()).toBeNull();

  current.phase = "connected";
  gateway.publish(current);
  const reconnected = page.capture();
  expect(reconnected).not.toBeNull();
  expect(view.ensureInitialData).toHaveBeenCalledTimes(2);
  expect(view.onIdentityChange).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledTimes(2);

  dispose();
  expect(gateway.listeners.size).toBe(0);
  expect(reconnected && page.isCurrent(reconnected)).toBe(false);
  expect([page.capture(), page.snapshot]).toEqual([null, null]);
  expectChange(invalidate, {
    identityChanged: false,
    snapshot: expect.objectContaining({ phase: "stopped" }),
  });
});

it("rebinds an equivalent replacement source and ignores the retired subscription", () => {
  const first = source();
  const second = source(first.gateway.snapshot);
  const [gateway, setGateway] = createSignal(first.gateway);
  const { page, onIdentityChange, invalidateRequests } = createGatewayFixture(gateway);
  const previous = page.capture();
  setGateway(second.gateway);
  flush();
  expect(previous && page.isCurrent(previous)).toBe(false);
  expect(
    page.isRouteDataCurrent({ gateway: first.gateway, gatewaySnapshot: first.gateway.snapshot }),
  ).toBe(false);
  expect([first.listeners.size, second.listeners.size]).toEqual([0, 1]);
  expectChange(onIdentityChange, { sourceChanged: true, identityChanged: true });
  const epoch = page.epoch;
  first.publish({ ...first.gateway.snapshot, phase: "reconnecting" });
  expect(page).toMatchObject({ epoch, connected: true });
  expect(invalidateRequests).toHaveBeenCalledOnce();
});

it("releases page-activation listeners with the Solid owner", () => {
  const gateway = source();
  const { dispose, onPageActivation } = createGatewayFixture(() => gateway.gateway);
  document.dispatchEvent(new Event("visibilitychange"));
  globalThis.dispatchEvent(new Event("focus"));
  expect(onPageActivation).toHaveBeenCalledTimes(2);
  dispose();
  document.dispatchEvent(new Event("visibilitychange"));
  globalThis.dispatchEvent(new Event("focus"));
  expect(onPageActivation).toHaveBeenCalledTimes(2);
});
