import { describe, expect, it } from "vitest";
import { monitorLineProvider } from "./monitor.js";

describe("monitorLineProvider lifecycle", () => {
  it("blocks until abort signal fires (#21908)", async () => {
    const abortController = new AbortController();

    const providerPromise = monitorLineProvider({
      channelAccessToken: "test-token",
      channelSecret: "test-secret",
      accountId: "test",
      config: {},
      runtime: {},
      abortSignal: abortController.signal,
    });

    // The provider must block (not resolve) while the abort signal is pending.
    // If it resolves immediately the gateway framework treats it as an exit
    // and triggers an auto-restart crash-loop.
    const TIMEOUT_MS = 200;
    const result = await Promise.race([
      providerPromise.then(() => "provider-resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS)),
    ]);

    expect(result).toBe("timeout");

    // After aborting, the provider should resolve.
    abortController.abort();
    const monitor = await providerPromise;
    expect(monitor.account).toBeDefined();
  });

  it("resolves immediately when abort signal is already aborted (#21908)", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const monitor = await monitorLineProvider({
      channelAccessToken: "test-token",
      channelSecret: "test-secret",
      accountId: "test",
      config: {},
      runtime: {},
      abortSignal: abortController.signal,
    });

    expect(monitor.account).toBeDefined();
  });
});
