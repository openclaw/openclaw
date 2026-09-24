// @vitest-environment node
import { GatewayProtocolClient } from "@openclaw/gateway-client/browser";
import { expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { createConfigCapabilityHarness, createConfigServerMock } from "./config-test-harness.ts";

const issues = [{ path: "count", message: "Expected number, received string" }];

async function validationError(
  overrides: ConstructorParameters<typeof GatewayRequestError>[0] = {
    code: "INVALID_REQUEST",
    message: "invalid config: count: Expected number, received string",
    details: { issues },
  },
) {
  const transport = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => ({
      isOpen: () => true,
      close: () => undefined,
      send: (data) => {
        const { id } = JSON.parse(data);
        handlers.message(JSON.stringify({ type: "res", id, ok: false, error: overrides }));
      },
    }),
    createRequestId: () => "validation-rejection",
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
  transport.start();
  try {
    await transport.request("config.set");
  } catch (error) {
    return error;
  } finally {
    transport.stop();
  }
  throw new Error("Expected a rejected response");
}

it.each(["save", "apply", "patch"] as const)(
  "%s retains rejected settings and accepts a correction on the unchanged revision",
  async (operation) => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    let reject = true;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (["config.set", "config.apply", "config.patch"].includes(method) && reject) {
        throw await validationError();
      }
      return server.request(method === "config.patch" ? "config.set" : method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    const original = runtimeConfig.state.configSnapshot;
    if (operation !== "patch") {
      runtimeConfig.patchForm(["count"], "invalid");
    }
    const submit = () =>
      operation === "patch"
        ? runtimeConfig.patch({ raw: { count: reject ? "invalid" : 2 }, note: "change count" })
        : runtimeConfig[operation]();

    await expect(submit()).resolves.toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("rejected");
    expect(runtimeConfig.state.lastError).toContain("count: Expected number");
    expect(runtimeConfig.state.configSnapshot).toEqual(original);
    expect(runtimeConfig.state.configForm).toEqual({
      count: operation === "patch" ? 1 : "invalid",
    });
    expect(runtimeConfig.state.configRecoveryError).toBeNull();

    reject = false;
    if (operation !== "patch") {
      runtimeConfig.patchForm(["count"], 2);
      expect(runtimeConfig.state.lastError).toBeNull();
    }
    await expect(submit()).resolves.toBe(true);
    expect(server.submissions).toEqual([
      {
        method: operation === "apply" ? "config.apply" : "config.set",
        raw: expect.any(String),
        baseHash: "hash-1",
      },
    ]);
    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.lastError).toBeNull();
    runtimeConfig.dispose();
  },
);

it.each([
  ["permission", "FORBIDDEN", "permission denied", { issues }, "error"],
  ["conflict", "INVALID_REQUEST", "config changed since last load", { issues }, "conflict"],
  ["request shape", "INVALID_REQUEST", "raw required", undefined, "error"],
  ["malformed issues", "INVALID_REQUEST", "invalid config", { issues: [{}] }, "error"],
  ["transport", "UNAVAILABLE", "connection closed", { issues }, "error"],
  [
    "partial publication",
    "INVALID_REQUEST",
    "publication failed",
    { issues, publication: "partial", rollbackStatus: "restored" },
    "error",
  ],
  [
    "complete publication",
    "INVALID_REQUEST",
    "publication failed",
    { issues, publication: "complete", rollbackStatus: "unknown" },
    "error",
  ],
  [
    "persisted write",
    "INVALID_REQUEST",
    "runtime apply failed",
    { issues, persistedConfig: { config: { count: 2 }, hash: "hash-2" } },
    "error",
  ],
] as const)(
  "keeps %s failures out of the validation notice",
  async (_label, code, message, details, status) => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.set") {
        throw await validationError({ code, message, details });
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    await expect(runtimeConfig.save()).resolves.toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe(status);
    runtimeConfig.setWritesSuspended(true);
    runtimeConfig.dispose();
  },
);

it("does not call an earlier uncertain save unchanged when a retry is rejected", async () => {
  vi.useFakeTimers();
  const server = createConfigServerMock();
  let writes = 0;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.set") {
      if (++writes === 1) {
        throw new Error("connection closed after dispatch");
      }
      throw await validationError();
    }
    return server.request(method, params);
  });
  const { runtimeConfig } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  await runtimeConfig.ensureLoaded();
  runtimeConfig.patchForm(["count"], 2);
  await expect(runtimeConfig.save()).resolves.toBe(false);
  await expect(runtimeConfig.retry()).resolves.toBe(false);
  await runtimeConfig.waitForPendingWrites();
  expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
  expect(runtimeConfig.state.lastError).toContain("could not be confirmed");
  expect(runtimeConfig.state.configFormDirty).toBe(true);
  runtimeConfig.setWritesSuspended(true);
  runtimeConfig.dispose();
});

it.each(["read", "schema"])(
  "replaces a validation notice when a later %s fails",
  async (operation) => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    let failedRead = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.set") {
        throw await validationError();
      }
      if (failedRead) {
        throw new Error("connection closed");
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], "invalid");
    await runtimeConfig.save();
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("rejected");
    await runtimeConfig.refresh({ background: true });
    expect(runtimeConfig.state.lastError).toContain("Expected number");
    await runtimeConfig.refresh();
    expect(runtimeConfig.state.lastError).toContain("Expected number");
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("rejected");
    failedRead = true;
    await (operation === "read" ? runtimeConfig.refresh() : runtimeConfig.ensureSchemaLoaded());
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.lastError).toBe("connection closed");
    runtimeConfig.setWritesSuspended(true);
    runtimeConfig.dispose();
  },
);
