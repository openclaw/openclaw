// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createConfigCapabilityHarness } from "./config-test-harness.ts";

describe("runtime config plugin activation", () => {
  it("refreshes loaded config and schema when lazy plugins publish on the same connection", async () => {
    const config = {
      cloudWorkers: {
        profiles: {
          cloud: {
            provider: "crabbox",
            install: "bundle",
            settings: { provider: "aws", class: "standard" },
          },
        },
      },
    };
    const request = vi.fn<GatewayBrowserClient["request"]>();
    request.mockResolvedValueOnce({
      valid: false,
      hash: "saved",
      appliedConfigHash: "saved",
      sourceConfig: {},
      resolved: {},
      config: {},
    });
    request.mockResolvedValueOnce({
      schema: { type: "object" },
      uiHints: {},
      version: "before",
      generatedAt: "2026-10-13T00:00:00Z",
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(request);
    await runtimeConfig.ensureLoaded();
    await runtimeConfig.ensureSchemaLoaded();
    expect(runtimeConfig.state.configValid).toBe(false);
    const refreshed = deferred();
    const stop = runtimeConfig.subscribe((state) => {
      if (state.configValid && state.configSchemaVersion === "active") {
        refreshed.resolve();
      }
    });
    request.mockResolvedValueOnce({
      valid: true,
      hash: "saved",
      appliedConfigHash: "saved",
      sourceConfig: config,
      resolved: config,
      config,
    });
    request.mockResolvedValueOnce({
      schema: { type: "object" },
      uiHints: {},
      version: "active",
      generatedAt: "2026-10-13T00:00:00Z",
    });
    publish(true, undefined, undefined, { generation: 1 });
    await refreshed.promise;
    stop();
    expect(runtimeConfig.state.configSnapshot?.sourceConfig).toEqual(config);
    expect(runtimeConfig.state.configSchemaVersion).toBe("active");
    expect(runtimeConfig.state.connected).toBe(true);
    const count = request.mock.calls.length;
    publish(true, undefined, undefined, { generation: 1 });
    expect(request).toHaveBeenCalledTimes(count);
    runtimeConfig.dispose();
  });
});
