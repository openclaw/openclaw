import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { useGatewayPage } from "./gateway-page.ts";

function connectedGateway(client: GatewayBrowserClient) {
  const source = createApplicationGateway();
  source.publish({ ...source.gateway.snapshot, client, phase: "connected" });
  return source;
}

function contextFor(gateway: ApplicationContext["gateway"]) {
  return { gateway } as ApplicationContext;
}

describe("Solid Gateway page lifetime", () => {
  it("retires requests synchronously through a same-client reconnect", async () => {
    const client = {} as GatewayBrowserClient;
    const source = connectedGateway(client);
    const ensureInitialData = vi.fn();
    const invalidateRequests = vi.fn();
    const mounted = createRoot((dispose) => ({
      dispose,
      page: useGatewayPage(contextFor(source.gateway), { ensureInitialData, invalidateRequests }),
    }));
    try {
      const original = mounted.page.capture();
      expect(original).not.toBeNull();
      await Promise.resolve();
      expect(ensureInitialData).toHaveBeenCalledTimes(1);
      source.publish({ ...source.gateway.snapshot, phase: "reconnecting" });
      expect(original && mounted.page.isCurrent(original)).toBe(false);
      expect(mounted.page.capture()).toBeNull();
      source.publish({ ...source.gateway.snapshot, phase: "connected" });
      const current = mounted.page.capture();
      expect(current?.client).toBe(client);
      expect(current?.epoch).not.toBe(original?.epoch);
      expect(ensureInitialData).toHaveBeenCalledTimes(2);
      expect(invalidateRequests).toHaveBeenCalledTimes(2);
    } finally {
      mounted.dispose();
    }
  });

  it("switches owner subscriptions even when the replacement reuses the client", async () => {
    const client = {} as GatewayBrowserClient;
    const first = connectedGateway(client);
    const second = connectedGateway(client);
    const onSnapshot = vi.fn();
    const mounted = createRoot((dispose) => {
      const [context, setContext] = createSignal(contextFor(first.gateway));
      return { dispose, setContext, page: useGatewayPage(context, { onSnapshot }) };
    });
    try {
      await Promise.resolve();
      const original = mounted.page.capture();
      mounted.setContext(contextFor(second.gateway));
      flush();
      expect(mounted.page.gateway).toBe(second.gateway);
      expect(original && mounted.page.isCurrent(original)).toBe(false);
      expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ sourceChanged: true }));
      onSnapshot.mockClear();
      first.publish({ ...first.gateway.snapshot, phase: "reconnecting" });
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(mounted.page.connected).toBe(true);
    } finally {
      mounted.dispose();
    }
  });

  it("never starts initial work after an immediate unmount", async () => {
    const source = connectedGateway({} as GatewayBrowserClient);
    const ensureInitialData = vi.fn();
    const mounted = createRoot((dispose) => ({
      dispose,
      page: useGatewayPage(contextFor(source.gateway), { ensureInitialData }),
    }));
    const original = mounted.page.capture();
    mounted.dispose();
    await Promise.resolve();
    expect(ensureInitialData).not.toHaveBeenCalled();
    expect(original && mounted.page.isCurrent(original)).toBe(false);
  });
});
