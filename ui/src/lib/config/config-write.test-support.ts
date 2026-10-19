import { expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  createGatewayHarness,
  createDeferredSetServerMock,
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
} from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

export function makeSnapshot(overrides: ConfigSnapshot = {}) {
  return { config: { count: 1 }, hash: "hash-1", valid: true, issues: [], ...overrides };
}

export function mockRequest(
  routes: Record<string, (params?: unknown) => unknown>,
  fallback: (params?: unknown) => unknown = () => ({}),
  methods?: string[],
) {
  return vi.fn(async (method: string, params?: unknown) => {
    methods?.push(method);
    return (routes[method] ?? fallback)(params);
  });
}

export function makeHarness(request: (method: string, params?: unknown) => Promise<unknown>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway, publish } = createGatewayHarness(client);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  return { client, publish, runtimeConfig, state: runtimeConfig.state };
}

export async function loadHarness(request: Parameters<typeof makeHarness>[0]) {
  const harness = makeHarness(request);
  await harness.runtimeConfig.ensureLoaded();
  return harness;
}

export async function pendingAutoSave() {
  vi.useFakeTimers();
  const server = createDeferredSetServerMock();
  const harness = await loadHarness(server.request);
  harness.runtimeConfig.patchForm(["count"], 2);
  await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  expect(server.submissions).toHaveLength(1);
  return { ...server, ...harness };
}
