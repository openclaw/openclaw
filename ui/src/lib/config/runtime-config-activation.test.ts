// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
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
    const schema = {
      schema: { type: "object" },
      uiHints: {},
      generatedAt: "2026-10-13T00:00:00Z",
    };
    request.mockResolvedValueOnce({
      valid: false,
      hash: "saved",
      appliedConfigHash: "saved",
      sourceConfig: {},
      resolved: {},
      config: {},
    });
    request.mockResolvedValueOnce({ ...schema, version: "before" });
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
    request.mockResolvedValueOnce({ ...schema, version: "active" });
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

  it.each([false, true])(
    "catches up plugin changes during a schema read (previous schema: %s)",
    async (warm) => {
      const oldSchema = deferred<unknown>();
      let hash = "initial";
      let version = "initial";
      let schemaRequests = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "config.schema") {
          schemaRequests++;
          return schemaRequests === (warm ? 2 : 1)
            ? oldSchema.promise
            : { schema: { type: "object" }, uiHints: {}, version };
        }
        return { config: {}, hash, valid: true, issues: [] };
      });
      const { runtimeConfig, publish } = createConfigCapabilityHarness(request);
      await runtimeConfig.ensureLoaded();
      if (warm) {
        await runtimeConfig.ensureSchemaLoaded();
      }
      const pending = warm ? runtimeConfig.refreshSchema() : runtimeConfig.ensureSchemaLoaded();
      const joined = runtimeConfig.refreshSchema();
      for (const generation of [1, 2]) {
        hash = `plugin-${generation}`;
        version = hash;
        publish(true, undefined, undefined, { generation });
        await waitForFast(() => expect(runtimeConfig.state.configSnapshot?.hash).toBe(hash));
      }
      expect(schemaRequests).toBe(warm ? 2 : 1);
      oldSchema.resolve({ schema: { type: "object" }, uiHints: {}, version: "old-plugin" });
      await Promise.all([pending, joined]);
      await waitForFast(() => expect(runtimeConfig.state.configSchemaVersion).toBe("plugin-2"));
      expect(schemaRequests).toBe(warm ? 3 : 2);
      runtimeConfig.dispose();
    },
  );

  it.each(["dispose", "reconnect"])(
    "retires a pending schema catch-up on %s",
    async (retirement) => {
      const oldSchema = deferred<unknown>();
      let hash = "initial";
      let schemaRequests = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "config.schema") {
          schemaRequests++;
          return schemaRequests === 2
            ? oldSchema.promise
            : { schema: { type: "object" }, uiHints: {}, version: "current" };
        }
        return { config: {}, hash, valid: true, issues: [] };
      });
      const { runtimeConfig, publish } = createConfigCapabilityHarness(request);
      await runtimeConfig.ensureLoaded();
      await runtimeConfig.ensureSchemaLoaded();
      const pending = runtimeConfig.refreshSchema();
      hash = "plugin";
      publish(true, undefined, undefined, { generation: 1 });
      await waitForFast(() => expect(runtimeConfig.state.configSnapshot?.hash).toBe(hash));
      if (retirement === "dispose") {
        runtimeConfig.dispose();
      } else {
        publish(false);
        hash = "reconnected";
        publish(true);
        await waitForFast(() => expect(schemaRequests).toBe(3));
      }
      oldSchema.resolve({ schema: { type: "object" }, uiHints: {}, version: "old-plugin" });
      await pending;
      // The continuation of the pending read has now had a turn to dispatch.
      await Promise.resolve();
      expect(schemaRequests).toBe(retirement === "dispose" ? 2 : 3);
      expect(runtimeConfig.state.configSchemaVersion).toBe("current");
      if (retirement !== "dispose") {
        runtimeConfig.dispose();
      }
    },
  );
});
