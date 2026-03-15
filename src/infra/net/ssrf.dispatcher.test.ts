import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  agentCtor,
  envHttpProxyAgentCtor,
  proxyAgentCtor,
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
} = vi.hoisted(() => ({
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
  getDefaultAutoSelectFamily: vi.fn(() => true as boolean | undefined),
  getDefaultAutoSelectFamilyAttemptTimeout: vi.fn(() => undefined as number | undefined),
}));

vi.mock("undici", () => ({
  Agent: agentCtor,
  EnvHttpProxyAgent: envHttpProxyAgentCtor,
  ProxyAgent: proxyAgentCtor,
}));

vi.mock("node:net", () => ({
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
}));

import { createPinnedDispatcher, type PinnedHostname } from "./ssrf.js";

describe("createPinnedDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when process-level autoSelectFamily is enabled (Node 22+ default)", () => {
    beforeEach(() => {
      getDefaultAutoSelectFamily.mockReturnValue(true);
      getDefaultAutoSelectFamilyAttemptTimeout.mockReturnValue(undefined);
    });

    it("sets default attempt timeout when process-level timeout is not configured", () => {
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
          autoSelectFamilyAttemptTimeout: 300,
          lookup,
        },
      });
    });

    it("respects process-level attempt timeout when configured", () => {
      const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
      const pinned: PinnedHostname = {
        hostname: "api.telegram.org",
        addresses: ["149.154.167.220"],
        lookup,
      };

      getDefaultAutoSelectFamilyAttemptTimeout.mockReturnValue(500);

      createPinnedDispatcher(pinned);

      expect(agentCtor).toHaveBeenCalledWith({
        connect: {
          autoSelectFamilyAttemptTimeout: 500,
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
          autoSelectFamilyAttemptTimeout: 600,
          lookup: previousLookup,
        },
      });

      expect(agentCtor).toHaveBeenCalledWith({
        connect: {
          autoSelectFamilyAttemptTimeout: 600,
          lookup,
        },
      });
    });

    it("allows caller to explicitly set autoSelectFamily", () => {
      const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
      const pinned: PinnedHostname = {
        hostname: "api.telegram.org",
        addresses: ["149.154.167.220"],
        lookup,
      };

      createPinnedDispatcher(pinned, {
        mode: "direct",
        connect: {
          autoSelectFamily: false,
        },
      });

      expect(agentCtor).toHaveBeenCalledWith({
        connect: {
          autoSelectFamily: false,
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
        connect: {
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 300,
          lookup,
        },
        proxyTls: {
          autoSelectFamily: true,
        },
      });
    });
  });

  describe("when process-level autoSelectFamily is disabled", () => {
    beforeEach(() => {
      getDefaultAutoSelectFamily.mockReturnValue(false);
      getDefaultAutoSelectFamilyAttemptTimeout.mockReturnValue(undefined);
    });

    it("respects process-level setting and does not set attempt timeout", () => {
      const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
      const pinned: PinnedHostname = {
        hostname: "api.telegram.org",
        addresses: ["149.154.167.220"],
        lookup,
      };

      createPinnedDispatcher(pinned);

      expect(agentCtor).toHaveBeenCalledWith({
        connect: {
          lookup,
        },
      });
    });

    it("still allows caller to explicitly enable autoSelectFamily", () => {
      const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
      const pinned: PinnedHostname = {
        hostname: "api.telegram.org",
        addresses: ["149.154.167.220"],
        lookup,
      };

      createPinnedDispatcher(pinned, {
        mode: "direct",
        connect: {
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 500,
        },
      });

      expect(agentCtor).toHaveBeenCalledWith({
        connect: {
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 500,
          lookup,
        },
      });
    });
  });

  describe("when getDefaultAutoSelectFamily is not available (older Node.js)", () => {
    beforeEach(() => {
      getDefaultAutoSelectFamily.mockImplementation(() => {
        throw new Error("Not available");
      });
      getDefaultAutoSelectFamilyAttemptTimeout.mockImplementation(() => {
        throw new Error("Not available");
      });
    });

    it("does not set any autoSelectFamily defaults", () => {
      const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
      const pinned: PinnedHostname = {
        hostname: "api.telegram.org",
        addresses: ["149.154.167.220"],
        lookup,
      };

      createPinnedDispatcher(pinned);

      expect(agentCtor).toHaveBeenCalledWith({
        connect: {
          lookup,
        },
      });
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
