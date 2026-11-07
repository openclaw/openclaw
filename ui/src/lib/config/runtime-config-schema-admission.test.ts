// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { createGatewayHarness, createConfigCapabilityHarness } from "./config-test-harness.ts";
import { makeSnapshot } from "./config-write.test-support.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("runtime config schema admission", () => {
  it.each(["before", "after"])(
    "admits a requested schema independently when hello arrives %s editor activation",
    async (helloTiming) => {
      const config = deferred<ConfigSnapshot>();
      const request = vi.fn(async (method: string) =>
        method === "config.schema"
          ? { schema: { type: "object" }, uiHints: {}, version: "ready" }
          : config.promise,
      );
      const { gateway, publish } = createGatewayHarness({
        request,
      } as unknown as GatewayBrowserClient);
      publish(false, undefined, null);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const reads = Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
      try {
        if (helloTiming === "after") {
          await reads;
        }
        expect(request).not.toHaveBeenCalled();
        publish(true);
        await vi.waitFor(() => expect(runtimeConfig.state.configSchemaVersion).toBe("ready"));
        expect(runtimeConfig.state.configSnapshot).toBeNull();
        expect(request.mock.calls.filter(([method]) => method === "config.schema")).toHaveLength(1);
      } finally {
        config.resolve(makeSnapshot());
        await reads;
        runtimeConfig.dispose();
      }
    },
  );

  it.each(["replacement", "disposal"])(
    "retires an unadmitted schema request on %s",
    async (retirement) => {
      const request = vi.fn(async () => makeSnapshot());
      const client = { request } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client);
      publish(false, client, null);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      await runtimeConfig.ensureSchemaLoaded();
      if (retirement === "disposal") {
        runtimeConfig.dispose();
      }
      publish(
        true,
        retirement === "replacement" ? ({ request } as unknown as GatewayBrowserClient) : client,
      );
      await Promise.resolve();
      expect(request).not.toHaveBeenCalledWith("config.schema", {});
      runtimeConfig.dispose();
    },
  );
});

describe("runtime config schema access", () => {
  it("loads the schema for a legacy hello without scopes or an advertised method list", async () => {
    const schema = {
      schema: { type: "object" },
      uiHints: {},
      version: "schema-legacy",
      generatedAt: "2026-08-15T00:00:00.000Z",
    };
    const request = vi.fn(async (method: string) =>
      method === "config.get"
        ? { config: {}, hash: "hash-legacy", valid: true, issues: [] }
        : method === "config.schema"
          ? schema
          : {},
    );
    const { client, publish, runtimeConfig, state } = createConfigCapabilityHarness(request);
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator" },
    } as GatewayHelloOk);
    await runtimeConfig.ensureSchemaLoaded();

    expect(request).toHaveBeenCalledWith("config.schema", {});
    expect(state.configSchemaVersion).toBe("schema-legacy");
    runtimeConfig.dispose();
  });

  it.each([false, true])(
    "skips the schema load without operator.read (before hello: %s)",
    async (beforeHello) => {
      const request = vi.fn(async () => ({}));
      const { client, publish, runtimeConfig } = createConfigCapabilityHarness(request);
      if (beforeHello) {
        publish(false, client, null);
        await runtimeConfig.ensureSchemaLoaded();
      }
      publish(true, client, {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.pairing"] },
        features: { methods: ["config.schema"] },
      } as GatewayHelloOk);
      await runtimeConfig.ensureSchemaLoaded();

      expect(request).not.toHaveBeenCalledWith("config.schema", {});
      runtimeConfig.dispose();
    },
  );
});
