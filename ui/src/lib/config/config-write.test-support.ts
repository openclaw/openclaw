import { expect, vi } from "vitest";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  createConfigCapabilityHarness,
  createDeferredSetServerMock,
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
} from "./config-test-harness.ts";

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

export async function loadHarness(request: Parameters<typeof createConfigCapabilityHarness>[0]) {
  const harness = createConfigCapabilityHarness(request);
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
