// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot } from "../../api/types.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { currentConfigObject, resolveAgentConfigEntryTarget } from "./config-state-model.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createGatewayHarness,
  createConfigServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("config state model", () => {
  it.each([false, true])(
    "settles foreground loading when its background successor finishes first (failure: %s)",
    async (failure) => {
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
        if (failure) {
          latest.reject(new Error("Current refresh failed"));
        } else {
          latest.resolve({ config: { count: 2 }, hash: "current" });
        }
        await refresh;
        expect(runtimeConfig.state.configLoading).toBe(false);
        expect(currentConfigObject(runtimeConfig.state)).toEqual(failure ? null : { count: 2 });
        initial.resolve({ config: { count: 1 }, hash: "previous" });
        await initialLoad;
        expect(runtimeConfig.state.configLoading).toBe(false);
        expect(currentConfigObject(runtimeConfig.state)).toEqual(failure ? null : { count: 2 });
        expect(runtimeConfig.state.lastError).toBe(failure ? "Current refresh failed" : null);
      } finally {
        initial.resolve({ config: { count: 1 }, hash: "previous" });
        runtimeConfig.dispose();
      }
    },
  );

  it.each([false, true])(
    "requires a current config read after connection recovery (replacement client: %s)",
    async (replaceClient) => {
      const server = createConfigServerMock();
      const client = createTestGatewayClient(server.request);
      const { gateway, publish } = createGatewayHarness(client);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      try {
        await runtimeConfig.ensureLoaded();
        expect(currentConfigObject(runtimeConfig.state)).toEqual({ count: 1 });
        server.request.mockRejectedValueOnce(new Error("New connection read failed"));
        const currentClient = replaceClient ? createTestGatewayClient(server.request) : client;
        publish(false);
        publish(true, currentClient);
        await vi.waitFor(() => expect(runtimeConfig.state.configLoading).toBe(false));

        expect(runtimeConfig.state.lastError).toBe("New connection read failed");
        expect(currentConfigObject(runtimeConfig.state)).toBeNull();
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
    },
  );

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

  it("keeps an acknowledged reconnect save readable when both config reads fail", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    let failReads = false;
    const client = createTestGatewayClient((method, params) => {
      if (method === "config.get" && failReads) {
        throw new Error("Configuration read failed");
      }
      return server.request(method, params);
    });
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      failReads = true;
      publish(false);
      publish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(currentConfigObject(runtimeConfig.state)).toBeNull();

      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(runtimeConfig.state.lastError).toBe("Configuration read failed");
      expect(runtimeConfig.state.configFormDirty).toBe(false);
      expect(currentConfigObject(runtimeConfig.state)).toEqual({ count: 2 });
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

  it("preserves a dirty draft and its original base hash across refreshes", async () => {
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "config.get") {
        return {};
      }
      getCount += 1;
      return getCount === 1
        ? { config: { count: 1 }, hash: "hash-1", valid: true, issues: [], raw: '{"count":1}' }
        : { config: { count: 3 }, hash: "hash-2", valid: true, issues: [], raw: '{"count":3}' };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    await runtimeConfig.refresh();

    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-1");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");

    await runtimeConfig.discardDraft({ reloadOnly: true });
    expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
    runtimeConfig.dispose();
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

  it("clears needsApply only on apply; a discarding refresh keeps the banner", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    // Discarding local edits does not undo the already-saved file: the
    // restart banner must survive until apply.
    runtimeConfig.patchForm(["count"], 9);
    await runtimeConfig.discardDraft({ reloadOnly: true });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    await expect(runtimeConfig.apply()).resolves.toBe(true);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(server.submissions.at(-1)?.method).toBe("config.apply");
    runtimeConfig.dispose();
  });

  it("derives needsApply across capability recreation from Gateway revision truth", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const first = createConfigCapabilityHarness(server.request as GatewayBrowserClient["request"]);
    await first.runtimeConfig.ensureLoaded();

    first.runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(first.runtimeConfig.state.configNeedsApply).toBe(true);
    first.runtimeConfig.dispose();

    // A fresh capability compares the persisted and applied revisions.
    const second = createConfigCapabilityHarness(server.request as GatewayBrowserClient["request"]);
    await second.runtimeConfig.ensureLoaded();
    expect(second.runtimeConfig.state.configNeedsApply).toBe(true);

    await expect(second.runtimeConfig.apply()).resolves.toBe(true);
    expect(second.runtimeConfig.state.configNeedsApply).toBe(false);
    second.runtimeConfig.dispose();

    // After apply advances runtime truth, a third load shows no banner.
    const third = createConfigCapabilityHarness(server.request as GatewayBrowserClient["request"]);
    await third.runtimeConfig.ensureLoaded();
    expect(third.runtimeConfig.state.configNeedsApply).toBe(false);
    third.runtimeConfig.dispose();
  });

  it("does not invent needsApply when an older Gateway omits the applied hash", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config.get" ? { config: {}, hash: "hash-1", valid: true, issues: [] } : {},
    );
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    runtimeConfig.dispose();
  });

  it("config.set retains process-local needsApply without applied revision metadata", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      return method === "config.set" ? { config: { count: 2 }, hash: "hash-2" } : {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();
  });

  it("treats a missing current config as drift from an applied revision", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config.get"
        ? {
            config: {},
            hash: null,
            configRevisionHash: null,
            appliedConfigHash: "applied-hash",
            valid: true,
            issues: [],
          }
        : {},
    );
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();
  });

  it("finds explicit agent entries", () => {
    expect(
      resolveAgentConfigEntryTarget(
        {
          agents: {
            entries: {
              main: {},
              assistant: { model: "openai/gpt-5.4" },
            },
          },
        },
        "assistant",
      ),
    ).toEqual({
      path: ["agents", "entries", "assistant"],
      entry: { model: "openai/gpt-5.4" },
    });
  });

  it("preserves the authored key while resolving normalized agent identities", () => {
    expect(
      resolveAgentConfigEntryTarget(
        {
          agents: {
            entries: {
              MAIN: { model: "openai/gpt-5.4" },
            },
          },
        },
        "main",
      ),
    ).toEqual({
      path: ["agents", "entries", "MAIN"],
      entry: { model: "openai/gpt-5.4" },
    });
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
