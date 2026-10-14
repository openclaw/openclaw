// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createConfigServerMock,
  createDeferredSetServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";

describe("config form commit flush", () => {
  it("flushes a field commit immediately and waits for the acknowledged trailing draft", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    const committed = vi.fn();
    const first = runtimeConfig.flushFormChanges().then(committed);
    expect(submissions).toHaveLength(1);
    expect(committed).not.toHaveBeenCalled();
    runtimeConfig.patchForm(["count"], 3);
    const second = runtimeConfig.flushFormChanges();
    expect(submissions).toHaveLength(1);
    firstSet.resolve({});
    await first;
    await expect(second).resolves.toBe(true);
    expect(committed).toHaveBeenCalledExactlyOnceWith(true);
    expect(submissions).toEqual([
      { raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
      { raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" },
    ]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
  });

  it("does not flush a retained draft into a reconnected Gateway", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    publish(false);
    publish(true);
    await vi.advanceTimersByTimeAsync(0);
    await expect(runtimeConfig.flushFormChanges()).resolves.toBe(false);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    runtimeConfig.dispose();
  });
});
