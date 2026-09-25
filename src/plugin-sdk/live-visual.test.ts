import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveLiveVisualProvider, type LiveVisualProvider } from "./live-visual.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("live visual plugin SDK", () => {
  it("registers and resolves a provider from the active plugin generation", async () => {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "visual-owner",
      name: "Visual Owner",
      source: "/tmp/visual-owner/index.js",
      origin: "global",
      enabled: true,
      contracts: { liveVisualProviders: ["lobster"] },
      configSchema: false,
    });
    const provider: LiveVisualProvider = {
      id: "lobster",
      label: "Lobster",
      open: vi.fn(),
    };

    builder.createApi(record, { config: {} }).registerLiveVisualProvider(provider);
    builder.registry.plugins.push(record);
    setActivePluginRegistry(builder.registry);

    expect(builder.registry.liveVisualProviders[0]?.provider).toBe(provider);
    expect(resolveLiveVisualProvider({ providerId: "lobster", config: {} })).toMatchObject({
      id: "lobster",
      label: "Lobster",
    });
    expect(record.liveVisualProviderIds).toEqual(["lobster"]);
    await expectDefined(getPluginInstance(record), "live visual provider owner").dispose();
  });

  it("fences retained provider and media calls while admitting session cleanup", async () => {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "visual-owner",
      name: "Visual Owner",
      source: "/tmp/visual-owner/index.js",
      origin: "global",
      enabled: true,
      contracts: { liveVisualProviders: ["lobster"] },
      configSchema: false,
    });
    const write = vi.fn(() => true);
    const health = vi.fn(() => ({ status: "ready" as const, droppedMediaBytes: 0 }));
    const close = vi.fn(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(builder.registry);
    });
    const open = vi.fn(async (request: Parameters<LiveVisualProvider["open"]>[0]) => ({
      output: {
        kind: "browser-source" as const,
        url: "http://127.0.0.1/avatar",
        video: request.video,
      },
      write,
      health,
      close,
    }));
    const provider: LiveVisualProvider = {
      id: "lobster",
      label: "Lobster",
      open,
    };

    builder.createApi(record, { config: {} }).registerLiveVisualProvider(provider);
    builder.registry.plugins.push(record);
    setActivePluginRegistry(builder.registry);
    const owner = expectDefined(getPluginInstance(record), "live visual provider owner");
    const resolved = expectDefined(
      resolveLiveVisualProvider({ providerId: "lobster", config: {} }),
      "resolved live visual provider",
    );
    const request = {
      streamId: "call-1",
      clock: { unitsPerSecond: 24_000 },
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: { encoding: "pcm-s16le" as const, sampleRateHz: 24_000, channels: 1 },
    };
    const session = await resolved.open(request);

    let disposed = false;
    const disposal = owner.dispose().then((result) => {
      disposed = true;
      return result;
    });
    try {
      await Promise.resolve();
      await expect(resolved.open({ ...request, streamId: "call-2" })).rejects.toThrow(
        /reloaded|disabled|retiring/,
      );
      expect(open).toHaveBeenCalledOnce();
      expect(() => session.write({ type: "flush", reason: "retired" })).toThrow(
        /reloaded|disabled|retiring/,
      );
      expect(write).not.toHaveBeenCalled();
      expect(() => session.health()).toThrow(/reloaded|disabled|retiring/);
      expect(health).not.toHaveBeenCalled();
      expect(disposed).toBe(false);

      await expect(session.close("retired")).resolves.toBeUndefined();
      await expect(disposal).resolves.toEqual({ errors: [] });
      expect(close).toHaveBeenCalledWith("retired");
    } finally {
      await Promise.allSettled([session.close("test-cleanup"), disposal]);
    }
  });

  it("retains cleanup when the owner retires during provider open", async () => {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "visual-owner",
      name: "Visual Owner",
      source: "/tmp/visual-owner/index.js",
      origin: "global",
      enabled: true,
      contracts: { liveVisualProviders: ["lobster"] },
      configSchema: false,
    });
    const opened = createDeferredCore();
    const continueOpen = createDeferredCore();
    const close = vi.fn(async () => {});
    const provider: LiveVisualProvider = {
      id: "lobster",
      label: "Lobster",
      async open(request) {
        opened.resolve();
        await continueOpen.promise;
        return {
          output: {
            kind: "browser-source",
            url: "http://127.0.0.1/avatar",
            video: request.video,
          },
          write: () => true,
          health: () => ({ status: "ready", droppedMediaBytes: 0 }),
          close,
        };
      },
    };

    builder.createApi(record, { config: {} }).registerLiveVisualProvider(provider);
    builder.registry.plugins.push(record);
    setActivePluginRegistry(builder.registry);
    const owner = expectDefined(getPluginInstance(record), "live visual provider owner");
    const resolved = expectDefined(
      resolveLiveVisualProvider({ providerId: "lobster", config: {} }),
      "resolved live visual provider",
    );
    const opening = resolved.open({
      streamId: "call-1",
      clock: { unitsPerSecond: 24_000 },
      video: { width: 1280, height: 720, frameRate: 30 },
    });
    await opened.promise;
    const disposal = owner.dispose();
    continueOpen.resolve();
    await expect(opening).rejects.toThrow(/reloaded|disabled|retiring/);
    await expect(disposal).resolves.toEqual({ errors: [] });
    expect(close).toHaveBeenCalledWith("provider-retired");
  });
});
