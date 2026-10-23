// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createGatewayHarness,
  createConfigServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("config gateway operations", () => {
  it.each(["config.get", "config.schema"] as const)(
    "retires an in-flight %s when read access is revoked on the same client",
    async (method) => {
      const pending = deferred<unknown>();
      const response =
        method === "config.get"
          ? { config: { endpoint: "restricted" }, hash: "restricted", valid: true, issues: [] }
          : { schema: { type: "object" }, uiHints: {}, version: "restricted" };
      const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(response);
      const client = createTestGatewayClient(request);
      const { gateway, publish } = createGatewayHarness(client);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const refresh = () =>
        method === "config.get" ? runtimeConfig.refresh() : runtimeConfig.refreshSchema();
      try {
        const loading = refresh();
        expect(request).toHaveBeenCalledWith(method, {});
        publish(true, client, gatewayHelloForMethods([method], ["operator.sessions.read"]));
        publish(true, client);
        pending.resolve(response);
        await loading;
        expect(runtimeConfig.state.configSnapshot).toBeNull();
        expect(runtimeConfig.state.configSchema).toBeNull();
        expect(runtimeConfig.state.configForm).toBeNull();
        expect(runtimeConfig.state.configLoading).toBe(false);
        expect(runtimeConfig.state.configSchemaLoading).toBe(false);

        await refresh();
        expect(
          method === "config.get"
            ? runtimeConfig.state.configSnapshot?.hash
            : runtimeConfig.state.configSchemaVersion,
        ).toBe("restricted");
      } finally {
        runtimeConfig.dispose();
      }
    },
  );

  it("config.apply adopts the canonical receipt before saving an in-flight edit", async () => {
    const method = "config.apply";
    vi.useFakeTimers();
    const ack = deferred<unknown>();
    const server = createConfigServerMock();
    const canonical = { count: 2, ui: { prefs: { locale: "fr" } } };
    let firstWrite = true;
    const request = vi.fn(async (operation: string, params?: unknown) => {
      if (operation === method && firstWrite) {
        firstWrite = false;
        await server.request(operation, params);
        await ack.promise;
        return { config: canonical, hash: "hash-2" };
      }
      if (operation === "config.get" && !firstWrite) {
        return { config: canonical, hash: "hash-2", valid: true, issues: [] };
      }
      return server.request(operation, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    const applied = runtimeConfig.apply();
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    runtimeConfig.patchForm(["count"], 3);
    ack.resolve({});
    await expect(applied).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(server.submissions).toHaveLength(2);
    expect(server.submissions[1]?.baseHash).toBe("hash-2");
    expect(server.submissions.map(({ raw }) => JSON.parse(raw))).toEqual([
      { count: 2 },
      { ...canonical, count: 3 },
    ]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
  });

  it("copies the config path when opening the file fails", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: {},
          hash: "hash-1",
          path: "/tmp/openclaw.json",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.openFile") {
        return { ok: false, error: "not supported", path: "/tmp/openclaw.json" };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();

    await runtimeConfig.openFile();
    expect(writeText).toHaveBeenCalledWith("/tmp/openclaw.json");
    expect(runtimeConfig.state.lastError).toContain("File path copied to clipboard");
    runtimeConfig.dispose();
  });

  it("config.set does not report Saved while edits made during the reload are still dirty", async () => {
    vi.useFakeTimers();
    let hashCounter = 1;
    let storedRaw = '{\n  "count": 1\n}\n';
    let deferReload: ReturnType<typeof deferred<unknown>> | null = null;
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        const response = {
          config: JSON.parse(storedRaw) as Record<string, unknown>,
          raw: storedRaw,
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
        if (deferReload) {
          const pending = deferReload;
          deferReload = null;
          return pending.promise.then(() => response);
        }
        return Promise.resolve(response);
      }
      if (method === "config.set") {
        storedRaw = (params as { raw: string }).raw;
        hashCounter += 1;
        return Promise.resolve({ config: JSON.parse(storedRaw), hash: `hash-${hashCounter}` });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const reloadGate = deferred<unknown>();
    deferReload = reloadGate;
    runtimeConfig.patchForm(["count"], 2);
    const save = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    // config.set acked; the post-save reload is held open while a new edit lands.
    runtimeConfig.patchForm(["count"], 3);
    reloadGate.resolve({});
    await expect(save).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");

    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("adopts config.patch acknowledgements for consecutive queued patches", async () => {
    const patchBaseHashes: string[] = [];
    let storedConfig: Record<string, unknown> = { count: 1 };
    let hashCounter = 1;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return {
          config: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.patch") {
        const patch = params as { baseHash: string; raw: string };
        patchBaseHashes.push(patch.baseHash);
        storedConfig = { ...storedConfig, ...(JSON.parse(patch.raw) as Record<string, unknown>) };
        hashCounter += 1;
        return { config: storedConfig, hash: `hash-${hashCounter}` };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const first = runtimeConfig.patch({ raw: { first: true }, note: "first test patch" });
    const second = runtimeConfig.patch({ raw: { second: true }, note: "second test patch" });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(patchBaseHashes).toEqual(["hash-1", "hash-2"]);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toEqual({ count: 1, first: true, second: true });
    runtimeConfig.dispose();
  });

  it("orders a patch acknowledgement after an older in-flight config load", async () => {
    vi.useFakeTimers();
    const staleLoad = deferred<ConfigSnapshot>();
    let getCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        getCalls += 1;
        if (getCalls === 2) {
          return staleLoad.promise;
        }
        return {
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.patch" || method === "config.set") {
        return { config: { count: 1, patched: true }, hash: "hash-2" };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const staleRefresh = runtimeConfig.refresh();
    expect(getCalls).toBe(2);
    await expect(
      runtimeConfig.patch({ raw: { patched: true }, note: "ordered patch test" }),
    ).resolves.toBe(true);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");

    staleLoad.resolve({
      config: { count: 1 },
      raw: '{"count":1}',
      hash: "hash-1",
      valid: true,
      issues: [],
    });
    await staleRefresh;
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    expect(runtimeConfig.state.configForm).toEqual({ count: 1, patched: true });
    // A refresh requested after the ack still owns its new snapshot.
    await runtimeConfig.refresh();
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-1");
    expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
    runtimeConfig.dispose();
  });
});
