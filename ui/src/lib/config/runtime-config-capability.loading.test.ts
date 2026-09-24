// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness } from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("runtime config load subscriptions", () => {
  it("clears a settled load when an observer throws so an explicit retry can read again", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable"));
    request.mockResolvedValue({ config: {}, hash: "ready", valid: true, issues: [] });
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const unsubscribe = runtimeConfig.subscribe((state) => {
      if (!state.configLoading && !state.configSnapshot) {
        throw new Error("observer failed");
      }
    });
    try {
      await expect(runtimeConfig.ensureLoaded()).rejects.toThrow("observer failed");
      unsubscribe();
      await runtimeConfig.ensureLoaded();
      expect(request).toHaveBeenCalledTimes(2);
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("ready");
    } finally {
      unsubscribe();
      runtimeConfig.dispose();
    }
  });

  it("shares a background refresh with an editor ensuring its first snapshot", async () => {
    const response = createDeferredCore<{
      config: Record<string, unknown>;
      hash: string;
      valid: boolean;
      issues: unknown[];
    }>();
    const request = vi.fn(() => response.promise);
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const pending: Promise<void>[] = [];
    const unsubscribe = runtimeConfig.subscribe((state) => {
      if (!state.configSnapshot && !state.configLoading) {
        pending.push(runtimeConfig.ensureLoaded());
      }
    });
    try {
      const refreshed = runtimeConfig.refresh({ background: true });
      expect(request).toHaveBeenCalledOnce();
      expect(runtimeConfig.state.configLoading).toBe(false);
      response.resolve({ config: {}, hash: "ready", valid: true, issues: [] });
      await refreshed;
      await Promise.all(pending);
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("ready");
      expect(request).toHaveBeenCalledOnce();
    } finally {
      response.resolve({ config: {}, hash: "ready", valid: true, issues: [] });
      unsubscribe();
      runtimeConfig.dispose();
    }
  });

  it.each(["ensureLoaded", "refresh"] as const)(
    "%s lets an offline editor ensure config without recursive notifications",
    async (action) => {
      const request = vi.fn(async () => ({ config: {}, hash: "ready", valid: true, issues: [] }));
      const client = { request } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client);
      publish(false);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const pending: Promise<void>[] = [];
      let depth = 0;
      let maxDepth = 0;
      const unsubscribe = runtimeConfig.subscribe((state) => {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
        // Bound a broken implementation so the regression reports re-entry,
        // rather than exhausting the process stack before cleanup can run.
        if (depth < 3 && !state.configSnapshot && !state.configLoading) {
          pending.push(runtimeConfig.ensureLoaded());
        }
        depth -= 1;
      });
      try {
        await runtimeConfig[action]();
        await Promise.all(pending);
        expect(maxDepth).toBe(1);
        expect(request).not.toHaveBeenCalled();

        publish(true);
        await runtimeConfig.ensureLoaded();
        expect(request).toHaveBeenCalledOnce();
        expect(runtimeConfig.state.configSnapshot?.hash).toBe("ready");
      } finally {
        unsubscribe();
        runtimeConfig.dispose();
      }
    },
  );

  it.each(["config", "schema"] as const)(
    "publishes %s loading immediately and leaves a failed read for explicit retry",
    async (kind) => {
      const request = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable"));
      request.mockResolvedValue({
        config: {},
        hash: "ready",
        valid: true,
        issues: [],
        schema: { type: "object" },
        uiHints: {},
        version: "ready",
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const { gateway } = createGatewayHarness(client);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const ensure = () =>
        kind === "config" ? runtimeConfig.ensureLoaded() : runtimeConfig.ensureSchemaLoaded();
      const loading = () =>
        kind === "config"
          ? runtimeConfig.state.configLoading
          : runtimeConfig.state.configSchemaLoading;
      const loaded = () =>
        kind === "config" ? runtimeConfig.state.configSnapshot : runtimeConfig.state.configSchema;
      const observed: boolean[] = [];
      const unsubscribe = runtimeConfig.subscribe(() => {
        observed.push(loading());
        if (!loading() && !loaded()) {
          void ensure();
        }
      });
      try {
        const first = ensure();
        expect(loading()).toBe(true);
        expect(observed).toContain(true);
        await first;
        expect(request).toHaveBeenCalledOnce();
        expect(loaded()).toBeNull();
        expect(runtimeConfig.state.lastError).toContain("temporarily unavailable");

        await ensure();
        expect(request).toHaveBeenCalledTimes(2);
        expect(loaded()).not.toBeNull();
      } finally {
        unsubscribe();
        runtimeConfig.dispose();
      }
    },
  );
});
