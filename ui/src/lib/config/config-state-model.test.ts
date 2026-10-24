// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot } from "../../api/types.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  beginConfigRead,
  clearConfigRequestVersions,
  createInitialConfigState,
  currentConfigObject,
  currentConfigRead,
  currentDisplayRuntimeConfig,
  currentDisplaySpeechConfig,
  resolveAgentConfigEntryTarget,
} from "./config-state-model.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createGatewayHarness,
  createConfigServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("config state model", () => {
  it("settles superseded observers without completing the underlying config request", async () => {
    const client = createTestGatewayClient(vi.fn());
    const state = createInitialConfigState({ client, phase: "connected" });
    const first = beginConfigRead(state, client);
    const completed = vi.fn();
    void first.completion.promise.then(completed);
    const next = beginConfigRead(state, client);

    await expect(first.settled).resolves.toEqual({
      ok: false,
      error: "The configuration refresh was superseded.",
    });
    expect(completed).not.toHaveBeenCalled();
    expect(currentConfigRead(state)).toBe(next);

    first.completion.resolve({ ok: true, value: undefined });
    await first.completion.promise;
    expect(completed).toHaveBeenCalledOnce();
    next.completion.resolve({ ok: true, value: undefined });
    await expect(next.settled).resolves.toEqual({ ok: true, value: undefined });
    clearConfigRequestVersions(state);
    await expect(next.settled).resolves.toEqual({ ok: true, value: undefined });
  });

  it("settles foreground loading when its background successor fails first", async () => {
    const initial = deferred<ConfigSnapshot>();
    const latest = deferred<ConfigSnapshot>();
    const request = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(latest.promise);
    const { gateway } = createGatewayHarness(createTestGatewayClient(request));
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    try {
      const initialLoad = runtimeConfig.ensureLoaded();
      const refresh = runtimeConfig.refresh({ background: true });
      expect(runtimeConfig.state.configLoading).toBe(true);
      latest.reject(new Error("Current refresh failed"));
      await refresh;
      expect(runtimeConfig.state.configLoading).toBe(false);
      expect(currentConfigObject(runtimeConfig.state)).toEqual(null);
      initial.resolve({ config: { count: 1 }, hash: "previous" });
      await initialLoad;
      expect(runtimeConfig.state.configLoading).toBe(false);
      expect(currentConfigObject(runtimeConfig.state)).toEqual(null);
      expect(runtimeConfig.state.lastError).toBe("Current refresh failed");
    } finally {
      initial.resolve({ config: { count: 1 }, hash: "previous" });
      runtimeConfig.dispose();
    }
  });

  it("requires a current config read after replacing the connection client", async () => {
    const server = createConfigServerMock();
    const client = createTestGatewayClient(server.request);
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    try {
      await runtimeConfig.ensureLoaded();
      expect(currentConfigObject(runtimeConfig.state)).toEqual({ count: 1 });
      expect(currentDisplayRuntimeConfig(runtimeConfig.state)).toBeNull();
      expect(currentDisplaySpeechConfig(runtimeConfig.state)).toEqual({ count: 1 });
      server.request.mockRejectedValueOnce(new Error("New connection read failed"));
      const currentClient = createTestGatewayClient(server.request);
      publish(false);
      publish(true, currentClient);
      await vi.waitFor(() => expect(runtimeConfig.state.configLoading).toBe(false));

      expect(runtimeConfig.state.lastError).toBe("New connection read failed");
      expect(currentConfigObject(runtimeConfig.state)).toBeNull();
      expect(currentDisplayRuntimeConfig(runtimeConfig.state)).toBeNull();
      expect(currentDisplaySpeechConfig(runtimeConfig.state)).toBeNull();
      await runtimeConfig.ensureLoaded();
      expect(currentConfigObject(runtimeConfig.state)).toBeNull();
      expect(server.request.mock.calls).toHaveLength(2);
      server.request.mockResolvedValueOnce({ config: { count: 9 }, hash: "current" });
      await runtimeConfig.refresh();
      expect(currentConfigObject(runtimeConfig.state)).toEqual({ count: 9 });

      server.request.mockRejectedValueOnce(new Error("Same connection refresh failed"));
      await runtimeConfig.refresh({ background: true });
      expect(runtimeConfig.state.lastError).toBe("Same connection refresh failed");
      expect(currentConfigObject(runtimeConfig.state)).toEqual({ count: 9 });
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("retains a paused draft until explicit refresh after a reconnect read failure", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const client = createTestGatewayClient(server.request);
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      server.request.mockRejectedValueOnce(new Error("New connection read failed"));
      publish(false);
      publish(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(currentConfigObject(runtimeConfig.state)).toBeNull();
      expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
      expect(runtimeConfig.state.configFormDirty).toBe(true);
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
      await runtimeConfig.refresh();
      expect(currentConfigObject(runtimeConfig.state)).toEqual({ count: 2 });
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(server.submissions).toHaveLength(0);
      await expect(runtimeConfig.save()).resolves.toBe(true);
      await expect(server.request("config.get")).resolves.toMatchObject({ config: { count: 2 } });
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("protects dirty raw and form drafts from document reload until saved or discarded", async () => {
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      expect(canReloadControlUiDocument()).toBe(true);
      runtimeConfig.setRaw('{"count":2}');
      expect(canReloadControlUiDocument()).toBe(false);
      expect(runtimeConfig.state.configRaw).toBe('{"count":2}');
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(canReloadControlUiDocument()).toBe(true);
      runtimeConfig.patchForm(["count"], 3);
      expect(canReloadControlUiDocument()).toBe(false);
      await runtimeConfig.discardDraft();
      expect(canReloadControlUiDocument()).toBe(true);
      runtimeConfig.setRaw('{"count":4}');
      expect(canReloadControlUiDocument()).toBe(false);
    } finally {
      runtimeConfig.dispose();
    }
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it("rejects stale config and schema work after reconnecting the same client", async () => {
    const firstConfig = deferred<ConfigSnapshot>();
    const secondConfig = deferred<ConfigSnapshot>();
    const firstSchema = deferred<ConfigSchemaResponse>();
    const secondSchema = deferred<ConfigSchemaResponse>();
    const configRequests = [firstConfig, secondConfig];
    const schemaRequests = [firstSchema, secondSchema];
    const request = vi.fn((method: string) => {
      const pending = method === "config.get" ? configRequests.shift() : schemaRequests.shift();
      if (!pending) {
        throw new Error(`unexpected request: ${method}`);
      }
      return pending.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    const staleConfigLoad = runtimeConfig.ensureLoaded();
    const staleSchemaLoad = runtimeConfig.ensureSchemaLoaded();
    publish(false);
    publish(true);
    const currentConfigLoad = runtimeConfig.ensureLoaded();
    const currentSchemaLoad = runtimeConfig.ensureSchemaLoaded();

    firstConfig.resolve({ config: { source: "stale" }, valid: true, issues: [], raw: "{}" });
    firstSchema.reject(new Error("stale schema failure"));
    await Promise.all([staleConfigLoad, staleSchemaLoad]);

    expect(runtimeConfig.state.configSnapshot).toBeNull();
    expect(runtimeConfig.state.configSchema).toBeNull();
    expect(runtimeConfig.state.lastError).toBeNull();
    expect(runtimeConfig.state.configLoading).toBe(true);
    expect(runtimeConfig.state.configSchemaLoading).toBe(true);

    secondConfig.resolve({ config: { source: "current" }, valid: true, issues: [], raw: "{}" });
    secondSchema.resolve({
      schema: { type: "object" },
      uiHints: {},
      version: "current",
      generatedAt: "2026-07-09T00:00:00.000Z",
    });
    await Promise.all([currentConfigLoad, currentSchemaLoad]);

    expect(runtimeConfig.state.configSnapshot?.config).toEqual({ source: "current" });
    expect(runtimeConfig.state.configSchema).toEqual({ type: "object" });
    expect(runtimeConfig.state.configSchemaVersion).toBe("current");
    expect(runtimeConfig.state.configLoading).toBe(false);
    expect(runtimeConfig.state.configSchemaLoading).toBe(false);
    runtimeConfig.dispose();
  });

  it("does not resolve missing, blank, or blocked entry keys", () => {
    const entries = JSON.parse(
      '{"__proto__":{"model":"openai/gpt-5.4"},"foo bar":{"model":"openai/gpt-5.4"}}',
    ) as Record<string, unknown>;
    const config = { agents: { entries } };

    expect(resolveAgentConfigEntryTarget(config, "missing")).toBeNull();
    expect(resolveAgentConfigEntryTarget(config, " ")).toBeNull();
    expect(resolveAgentConfigEntryTarget(config, "__proto__")).toBeNull();
    expect(resolveAgentConfigEntryTarget(config, "foo-bar")).toBeNull();
  });
});
