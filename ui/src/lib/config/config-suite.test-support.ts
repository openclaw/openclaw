import { GatewayProtocolClient } from "@openclaw/gateway-client/browser";
import { afterEach, expect, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import type { ConfigAutoSaveStatus, RuntimeConfigState } from "./config-state-model.ts";
import { createConfigCapabilityHarness, createConfigServerMock } from "./config-test-harness.ts";

type ConfigHarness = ReturnType<typeof createConfigCapabilityHarness>;
type ConfigRequest = Parameters<typeof createConfigCapabilityHarness>[0];
const capabilities = new Map<ConfigHarness["runtimeConfig"], boolean>();
const transports = new Set<GatewayProtocolClient<Record<string, never>>>();
afterEach(() => {
  for (const [capability, suspend] of capabilities) {
    if (suspend) {
      capability.setWritesSuspended(true);
    }
    capability.dispose();
  }
  capabilities.clear();
  for (const transport of transports) {
    transport.stop();
  }
  transports.clear();
});

function managedConfig(harness: ConfigHarness, suspend = false) {
  capabilities.set(harness.runtimeConfig, suspend);
  return { ...harness, state: harness.runtimeConfig.state };
}

export function configHarness(request: ConfigRequest, suspend = false) {
  return managedConfig(createConfigCapabilityHarness(request), suspend);
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
      const submission = params as { raw: string; baseHash: string };
      if (submission.baseHash !== store.currentHash()) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "config changed since last load; re-run config.get and retry",
        });
      }
      if (method === "config.patch") {
        const snapshot = (await store.request("config.get")) as ConfigSnapshot;
        // These scenarios patch separate top-level values; the existing store
        // still owns persisted bytes, revision hashes, and applied revisions.
        const config = {
          ...snapshot.config,
          ...(JSON.parse(submission.raw) as Record<string, unknown>),
        };
        if (JSON.stringify(config) === JSON.stringify(snapshot.config)) {
          return { noop: true, config };
        }
        await store.request("config.set", {
          raw: JSON.stringify(config),
          baseHash: submission.baseHash,
        });
        return { config, hash: store.currentHash() };
      }
    }
    return store.request(method, params);
  });
  return { store, request };
}

export function configSnapshot(
  config: Record<string, unknown>,
  hash = "hash-1",
  raw = JSON.stringify(config),
) {
  return { config, raw, hash, valid: true, issues: [] };
}

export async function expectStoredConfig(
  server: { request: (method: string) => Promise<unknown> },
  config: Record<string, unknown>,
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
  transports.add(transport);
  return transport;
}

export async function loadedConfig(request: ConfigRequest, suspend = false) {
  const harness = configHarness(request, suspend);
  await harness.runtimeConfig.ensureLoaded();
  return harness;
}
