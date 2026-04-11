import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyBootstrapState = vi.hoisted(() => ({
  events: [] as Array<"bootstrap" | "impl">,
}));

vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(() => {
    proxyBootstrapState.events.push("bootstrap");
  }),
}));

vi.mock("./server.impl.js", () => ({
  startGatewayServer: vi.fn(async () => {
    proxyBootstrapState.events.push("impl");
    return { close: vi.fn(async () => undefined) };
  }),
  __resetModelCatalogCacheForTest: vi.fn(),
}));

describe("startGatewayServer proxy bootstrap", () => {
  beforeEach(() => {
    proxyBootstrapState.events = [];
  });

  it("installs the env HTTP proxy dispatcher before loading the gateway impl on every call", async () => {
    const mod = await import("./server.js");

    await mod.startGatewayServer(4321, { bind: "loopback" });
    await mod.startGatewayServer(4322, { bind: "loopback" });

    expect(proxyBootstrapState.events).toEqual(["bootstrap", "impl", "bootstrap", "impl"]);
  });
});
