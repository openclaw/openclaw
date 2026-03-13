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
  it("enables Happy Eyeballs by default for IPv6/IPv4 dual-stack compatibility", () => {
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
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        lookup,
      },
    });
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
        autoSelectFamilyAttemptTimeout: 500, // Caller can override defaults
        lookup: previousLookup,
      },
    });

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: true, // Default preserved when not overridden
        autoSelectFamilyAttemptTimeout: 500, // Caller's value wins
        lookup,
      },
    });
  });

  it("allows caller to explicitly disable autoSelectFamily", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    createPinnedDispatcher(pinned, {
      mode: "direct",
      connect: {
        autoSelectFamily: false, // Explicitly disable
      },
    });

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: false, // Caller's explicit value wins
        autoSelectFamilyAttemptTimeout: 300, // Default preserved
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
      connect: {
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300, // Default applied by withPinnedLookup
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
      proxyTls: {
        autoSelectFamily: false,
      },
    });
  });
});
