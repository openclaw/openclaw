import { describe, expect, it, vi } from "vitest";

const { agentCtor, envHttpProxyAgentCtor, proxyAgentCtor } = vi.hoisted(() => ({
  agentCtor: vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
  envHttpProxyAgentCtor: vi.fn(function MockEnvHttpProxyAgent(
    this: { options: unknown },
    options: unknown,
  ) {
    this.options = options;
  }),
  proxyAgentCtor: vi.fn(function MockProxyAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));

vi.mock("undici", () => ({
  Agent: agentCtor,
  EnvHttpProxyAgent: envHttpProxyAgentCtor,
  ProxyAgent: proxyAgentCtor,
}));

import { createPinnedDispatcher, type PinnedHostname } from "./ssrf.js";

describe("createPinnedDispatcher", () => {
  it("uses pinned lookup without overriding global family policy", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    const dispatcher = createPinnedDispatcher(pinned);

    expect(dispatcher).toBeDefined();
    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        lookup,
      },
    });
    const firstCallArg = agentCtor.mock.calls[0]?.[0] as
      | { connect?: Record<string, unknown> }
      | undefined;
    expect(firstCallArg?.connect?.autoSelectFamily).toBeUndefined();
  });

  it("preserves caller transport hints while overriding lookup", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const previousLookup = vi.fn();
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, {
      mode: "direct",
      connect: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup: previousLookup,
      },
    });

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup,
      },
    });
  });

  it("keeps env proxy route while pinning the direct no-proxy path", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, {
      mode: "env-proxy",
      connect: {
        autoSelectFamily: true,
      },
      proxyTls: {
        autoSelectFamily: true,
      },
    });

    expect(envHttpProxyAgentCtor).toHaveBeenCalledWith({
      keepAlive: false,
      connect: {
        autoSelectFamily: true,
        lookup,
      },
      proxyTls: {
        autoSelectFamily: true,
      },
    });
  });

  it("keeps explicit proxy routing intact", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, {
      mode: "explicit-proxy",
      proxyUrl: "http://127.0.0.1:7890",
      proxyTls: {
        autoSelectFamily: false,
      },
    });

    expect(proxyAgentCtor).toHaveBeenCalledWith({
      uri: "http://127.0.0.1:7890",
      connect: { keepAlive: false },
      proxyTls: {
        autoSelectFamily: false,
      },
    });
  });
});
