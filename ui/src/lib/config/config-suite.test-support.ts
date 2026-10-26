import { GatewayProtocolClient } from "@openclaw/gateway-client/browser";
import { afterEach, expect, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import type { ConfigAutoSaveStatus, RuntimeConfigState } from "./config-state-model.ts";
import { createConfigCapabilityHarness, createConfigServerMock } from "./config-test-harness.ts";

type ConfigRequest = Parameters<typeof createConfigCapabilityHarness>[0];
type Config = Record<string, unknown>;
const capabilityCleanups: Array<() => void> = [];
const transportCleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of [...capabilityCleanups.splice(0), ...transportCleanups.splice(0)]) {
    cleanup();
  }
});

export function configHarness(request: ConfigRequest, suspend = false) {
  const harness = createConfigCapabilityHarness(request);
  capabilityCleanups.push(() => {
    if (suspend) {
      harness.runtimeConfig.setWritesSuspended(true);
    }
    harness.runtimeConfig.dispose();
  });
  return harness;
}

export function expectFeedback(
  state: RuntimeConfigState,
  status: ConfigAutoSaveStatus,
  error: unknown = null,
) {
  expect(state).toMatchObject({ configAutoSaveStatus: status, lastError: error });
}

export function expectCalls(
  request: { mock: { calls: readonly (readonly unknown[])[] } },
  method: string,
  count: number,
) {
  expect(request.mock.calls.filter(([name]) => name === method)).toHaveLength(count);
}

export function createPatchServer() {
  const store = createConfigServerMock();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.patch" || method === "config.set") {
      const { raw, baseHash } = params as { raw: string; baseHash: string };
      if (baseHash !== store.currentHash()) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "config changed since last load; re-run config.get and retry",
        });
      }
      if (method === "config.patch") {
        const snapshot = (await store.request("config.get")) as ConfigSnapshot;
        // Shallow patches only; the store owns persistence and revisions.
        const config = { ...snapshot.config, ...(JSON.parse(raw) as Config) };
        if (JSON.stringify(config) === JSON.stringify(snapshot.config)) {
          return { noop: true, config };
        }
        await store.request("config.set", { raw: JSON.stringify(config), baseHash });
        return { config, hash: store.currentHash() };
      }
    }
    return store.request(method, params);
  });
  return { store, request };
}

export async function expectStoredConfig(
  server: { request: (method: string) => Promise<unknown> },
  config: Config,
) {
  await expect(server.request("config.get")).resolves.toMatchObject({ config });
}

type ConfigRequestFrame = { id: string; method: string; params: unknown };
export function configServerTransport(
  reply: (
    frame: ConfigRequestFrame,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: unknown }>,
  createRequestId: () => string,
) {
  const transport = new GatewayProtocolClient<Record<string, never>>({
    createRequestId,
    createSocket: (handlers) => ({
      isOpen: () => true,
      close: () => undefined,
      send: (data) => {
        const frame = JSON.parse(data) as ConfigRequestFrame;
        void reply(frame).then((response) =>
          handlers.message(JSON.stringify({ type: "res", id: frame.id, ...response })),
        );
      },
    }),
    createRequestError: (error) =>
      new GatewayRequestError({
        code: error.code ?? "UNAVAILABLE",
        message: error.message ?? "request failed",
        details: error.details,
      }),
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  transportCleanups.push(() => transport.stop());
  return transport;
}

export async function loadedConfig(request: ConfigRequest, suspend = false) {
  const harness = configHarness(request, suspend);
  await harness.runtimeConfig.ensureLoaded();
  return harness;
}
