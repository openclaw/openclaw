// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createConfigCapabilityHarness, createGatewayHarness } from "./config-test-harness.ts";
import { makeSnapshot } from "./config-write.test-support.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("runtime config load retries", () => {
  // Solid effects re-ensure config on a later microtask after each publication;
  // the cap keeps a regression from spinning the test forever.
  function reensureOnPublish(
    runtimeConfig: { subscribe: (listener: () => void) => () => void },
    ensure: () => Promise<void>,
  ) {
    let calls = 0;
    const stop = runtimeConfig.subscribe(() => {
      if (calls < 50) {
        calls += 1;
        queueMicrotask(() => void ensure().catch(() => undefined));
      }
    });
    return { stop, calls: () => calls };
  }
  const settleMicrotasks = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

  it.each(["display", "editor"] as const)(
    "does not republish %s loads that cannot start before read access",
    async (kind) => {
      const request = vi.fn(async () => makeSnapshot());
      const client = {
        request,
        auth: { role: "operator", scopes: ["operator.sessions.read"] },
      } as unknown as GatewayBrowserClient;
      const { gateway } = createGatewayHarness(client);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const ensure =
        kind === "display" ? runtimeConfig.ensureDisplayLoaded : runtimeConfig.ensureLoaded;
      const observer = reensureOnPublish(runtimeConfig, ensure);
      try {
        await ensure();
        await settleMicrotasks();
        expect(observer.calls()).toBeLessThan(3);
        expect(request).not.toHaveBeenCalled();
      } finally {
        observer.stop();
        runtimeConfig.dispose();
      }
    },
  );

  it.each(["display", "editor"] as const)(
    "retries failed %s loads only after a cooldown or an explicit refresh",
    async (kind) => {
      vi.useFakeTimers();
      const request = vi.fn(async () => {
        throw new Error("gateway restarting");
      });
      const { runtimeConfig } = createConfigCapabilityHarness(request);
      const ensure =
        kind === "display" ? runtimeConfig.ensureDisplayLoaded : runtimeConfig.ensureLoaded;
      const observer = reensureOnPublish(runtimeConfig, ensure);
      try {
        await ensure().catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(5_000);
        await ensure().catch(() => undefined);
        expect(request).toHaveBeenCalledTimes(2);

        // An explicit refresh is the user's retry and never waits for the cooldown.
        await (kind === "display" ? runtimeConfig.refreshDisplay() : runtimeConfig.refresh()).catch(
          () => undefined,
        );
        expect(request).toHaveBeenCalledTimes(3);
      } finally {
        observer.stop();
        runtimeConfig.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("keeps reload available when editing opens after a failed display read", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway restarting"))
      .mockResolvedValue(makeSnapshot());
    const { runtimeConfig, state } = createConfigCapabilityHarness(request);
    try {
      await runtimeConfig.ensureDisplayLoaded();
      await runtimeConfig.ensureLoaded();
      expect(state.configLoading).toBe(false);
      expect(request).toHaveBeenCalledOnce();

      await runtimeConfig.refresh();
      expect(state.configSnapshot?.hash).toBe("hash-1");
      expect(state.configLoading).toBe(false);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      runtimeConfig.dispose();
      vi.useRealTimers();
    }
  });
});
