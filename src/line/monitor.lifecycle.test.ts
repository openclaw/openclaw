import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

const { createLineBotMock, registerPluginHttpRouteMock, unregisterHttpMock } = vi.hoisted(() => ({
  createLineBotMock: vi.fn(() => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn(),
  })),
  registerPluginHttpRouteMock: vi.fn(),
  unregisterHttpMock: vi.fn(),
}));

vi.mock("./bot.js", () => ({
  createLineBot: createLineBotMock,
}));

vi.mock("../plugins/http-path.js", () => ({
  normalizePluginHttpPath: (_path: string | undefined, fallback: string) => fallback,
}));

vi.mock("../plugins/http-registry.js", () => ({
  registerPluginHttpRoute: registerPluginHttpRouteMock,
}));

vi.mock("./webhook-node.js", () => ({
  createLineNodeWebhookHandler: vi.fn(() => vi.fn()),
}));

describe("monitorLineProvider lifecycle", () => {
  beforeEach(() => {
    createLineBotMock.mockClear();
    unregisterHttpMock.mockClear();
    registerPluginHttpRouteMock.mockClear().mockReturnValue(unregisterHttpMock);
  });

  it("waits for abort before resolving", async () => {
    const { monitorLineProvider } = await import("./monitor.js");
    const abort = new AbortController();
    let resolved = false;

    const task = monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    }).then((monitor) => {
      resolved = true;
      return monitor;
    });

    await vi.waitFor(() => expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1));
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when signal is already aborted", async () => {
    const { monitorLineProvider } = await import("./monitor.js");
    const abort = new AbortController();
    abort.abort();

    await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    });

    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("returns immediately without abort signal and stop is idempotent", async () => {
    const { monitorLineProvider } = await import("./monitor.js");

    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    expect(unregisterHttpMock).not.toHaveBeenCalled();
    monitor.stop();
    monitor.stop();
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });
});
