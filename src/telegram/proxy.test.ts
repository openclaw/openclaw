import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
  const setGlobalDispatcher = vi.fn();
  class ProxyAgent {
    static lastCreated: ProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      ProxyAgent.lastCreated = this;
      proxyAgentSpy(proxyUrl);
    }
  }

  return {
    ProxyAgent,
    undiciFetch,
    proxyAgentSpy,
    setGlobalDispatcher,
    getLastAgent: () => ProxyAgent.lastCreated,
  };
});

vi.mock("undici", () => ({
  ProxyAgent: mocks.ProxyAgent,
  fetch: mocks.undiciFetch,
  setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

import { makeProxyFetch } from "./proxy.js";

describe("makeProxyFetch", () => {
  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    mocks.undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    await proxyFetch("https://api.telegram.org/bot123/getMe");

    expect(mocks.proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(mocks.undiciFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123/getMe",
      expect.objectContaining({ dispatcher: mocks.getLastAgent() }),
    );
    expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled();
  });
});
