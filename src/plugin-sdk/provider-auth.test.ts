// Provider auth tests cover credential resolution, setup state, and auth method contracts.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

type FallbackStoreCaseResult = {
  profileIds: string[];
  resolvedKey: string | undefined;
  resolveApiKeyCalls: unknown[][];
};

async function runFallbackStoreCase(): Promise<FallbackStoreCaseResult> {
  vi.resetModules();

  const primaryStore: AuthProfileStore = {
    version: 1,
    profiles: {},
  };
  const fallbackStore: AuthProfileStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "fallback-key",
      },
    },
  };
  const resolveApiKeyForProfile = vi.fn(
    async (params: { store: AuthProfileStore; profileId: string }) => {
      const profile = params.store.profiles[params.profileId];
      return profile?.type === "api_key" && profile.key
        ? {
            apiKey: profile.key,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          }
        : null;
    },
  );

  vi.doMock("../agents/agent-scope-config.js", () => ({
    resolveDefaultAgentDir: () => "/tmp/openclaw-agent",
  }));
  vi.doMock("../agents/auth-profiles/oauth.js", () => ({
    resolveApiKeyForProfile,
  }));
  vi.doMock("../agents/auth-profiles/order.js", () => ({
    resolveAuthProfileOrder: ({ provider, store }: { provider: string; store: AuthProfileStore }) =>
      Object.entries(store.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId),
  }));
  vi.doMock("../agents/auth-profiles/store.js", () => ({
    ensureAuthProfileStore: vi.fn(() => primaryStore),
    ensureAuthProfileStoreForLocalUpdate: vi.fn(() => primaryStore),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(() => primaryStore),
    loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => fallbackStore),
    updateAuthProfileStoreWithLock: vi.fn(),
  }));

  const { listUsableProviderAuthProfileIds, resolveProviderAuthProfileApiKey } =
    await import("./provider-auth.js");

  return {
    profileIds: listUsableProviderAuthProfileIds({ provider: "openai" }).profileIds,
    resolvedKey: await resolveProviderAuthProfileApiKey({ provider: "openai" }),
    resolveApiKeyCalls: resolveApiKeyForProfile.mock.calls,
  };
}

describe("provider auth profile helpers", () => {
  let fallbackStoreCase: FallbackStoreCaseResult;

  beforeAll(async () => {
    fallbackStoreCase = await runFallbackStoreCase();
  });

  afterEach(() => {
    vi.doUnmock("../agents/agent-scope-config.js");
    vi.doUnmock("../agents/auth-profiles/external-cli-discovery.js");
    vi.doUnmock("../agents/auth-profiles/oauth.js");
    vi.doUnmock("../agents/auth-profiles/order.js");
    vi.doUnmock("../agents/auth-profiles/store.js");
    vi.resetModules();
  });

  it("resolves API keys from the fallback store that supplied usable profile ids", () => {
    expect(fallbackStoreCase.profileIds).toEqual(["openai:default"]);
    expect(fallbackStoreCase.resolvedKey).toBe("fallback-key");
    expect(fallbackStoreCase.resolveApiKeyCalls).toContainEqual([
      expect.objectContaining({
        agentDir: "/tmp/openclaw-agent",
        profileId: "openai:default",
        store: expect.objectContaining({
          profiles: expect.objectContaining({
            "openai:default": expect.objectContaining({ key: "fallback-key" }),
          }),
        }),
      }),
    ]);
  });

  it("filters auth profile API-key resolution by credential type", async () => {
    vi.resetModules();

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:oauth": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "sk-profile",
        },
      },
    };
    const resolveApiKeyForProfile = vi.fn(
      async (params: { store: AuthProfileStore; profileId: string }) => {
        const profile = params.store.profiles[params.profileId];
        if (profile?.type === "oauth") {
          return {
            apiKey: profile.access,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          };
        }
        if (profile?.type === "api_key" && profile.key) {
          return {
            apiKey: profile.key,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          };
        }
        return null;
      },
    );

    vi.doMock("../agents/agent-scope-config.js", () => ({
      resolveDefaultAgentDir: () => "/tmp/openclaw-agent",
    }));
    vi.doMock("../agents/auth-profiles/oauth.js", () => ({
      resolveApiKeyForProfile,
    }));
    vi.doMock("../agents/auth-profiles/order.js", () => ({
      resolveAuthProfileOrder: ({
        provider,
        store: profileStore,
      }: {
        provider: string;
        store: AuthProfileStore;
      }) =>
        Object.entries(profileStore.profiles)
          .filter(([, profile]) => profile.provider === provider)
          .map(([profileId]) => profileId),
    }));
    vi.doMock("../agents/auth-profiles/store.js", () => ({
      ensureAuthProfileStore: vi.fn(() => store),
      ensureAuthProfileStoreForLocalUpdate: vi.fn(() => store),
      loadAuthProfileStoreForSecretsRuntime: vi.fn(() => store),
      loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
      updateAuthProfileStoreWithLock: vi.fn(),
    }));

    const { resolveProviderAuthProfileApiKey } = await import("./provider-auth.js");

    await expect(
      resolveProviderAuthProfileApiKey({
        provider: "openai",
        profileTypes: ["api_key"],
      }),
    ).resolves.toBe("sk-profile");
    expect(resolveApiKeyForProfile).toHaveBeenCalledTimes(1);
    expect(resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:key" }),
    );
  });

  it("only discovers external CLI auth when provider resolution opts in", async () => {
    vi.resetModules();

    const primaryStore: AuthProfileStore = {
      version: 1,
      profiles: {},
    };
    const externalStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    const externalCli = { mode: "scoped", providerIds: ["openai"] };
    const loadAuthProfileStoreForSecretsRuntime = vi.fn(
      (_agentDir?: string, options?: { externalCli?: unknown }) =>
        options?.externalCli ? externalStore : primaryStore,
    );

    vi.doMock("../agents/agent-scope-config.js", () => ({
      resolveDefaultAgentDir: () => "/tmp/openclaw-agent",
    }));
    vi.doMock("../agents/auth-profiles/external-cli-discovery.js", () => ({
      externalCliDiscoveryForProviderAuth: vi.fn(() => externalCli),
    }));
    vi.doMock("../agents/auth-profiles/oauth.js", () => ({
      resolveApiKeyForProfile: vi.fn(),
    }));
    vi.doMock("../agents/auth-profiles/order.js", () => ({
      resolveAuthProfileOrder: ({
        provider,
        store,
      }: {
        provider: string;
        store: AuthProfileStore;
      }) =>
        Object.entries(store.profiles)
          .filter(([, profile]) => profile.provider === provider)
          .map(([profileId]) => profileId),
    }));
    vi.doMock("../agents/auth-profiles/store.js", () => ({
      ensureAuthProfileStore: vi.fn(() => primaryStore),
      ensureAuthProfileStoreForLocalUpdate: vi.fn(() => primaryStore),
      loadAuthProfileStoreForSecretsRuntime,
      loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
      updateAuthProfileStoreWithLock: vi.fn(),
    }));

    const { isProviderAuthProfileConfigured } = await import("./provider-auth.js");

    expect(isProviderAuthProfileConfigured({ provider: "openai" })).toBe(false);
    expect(
      isProviderAuthProfileConfigured({
        provider: "openai",
        includeExternalCliAuth: true,
      }),
    ).toBe(true);
    expect(loadAuthProfileStoreForSecretsRuntime).toHaveBeenNthCalledWith(1, "/tmp/openclaw-agent");
    expect(loadAuthProfileStoreForSecretsRuntime).toHaveBeenNthCalledWith(
      2,
      "/tmp/openclaw-agent",
      { externalCli },
    );
  });

  it("accepts plus-signed Copilot token expiry strings", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "token;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: "+2000000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      fetchImpl,
      cachePath: "/tmp/copilot-token.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(result.expiresAt).toBe(2_000_000_000_000);
    expect(saved).toEqual([
      expect.objectContaining({
        expiresAt: 2_000_000_000_000,
        token: "token;proxy-ep=proxy.individual.githubcopilot.com",
      }),
    ]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual(
      expect.objectContaining({
        Accept: "application/json",
        Authorization: "Bearer github-token",
        "Copilot-Integration-Id": "vscode-chat",
      }),
    );
  });

  it("rejects malformed Copilot proxy hints", async () => {
    vi.resetModules();

    const { deriveCopilotApiBaseUrlFromToken } = await import("./provider-auth.js");

    expect(
      deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=javascript:alert(1);"),
    ).toBeNull();
    expect(deriveCopilotApiBaseUrlFromToken("copilot-token;proxy-ep=://bad;")).toBeNull();
  });

  it("rejects Copilot token expiry values outside the supported date range", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "token;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: Number.MAX_SAFE_INTEGER,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    await expect(
      resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl,
        cachePath: "/tmp/copilot-token.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {
          throw new Error("should not save invalid token");
        },
      }),
    ).rejects.toThrow("Copilot token response has invalid expires_at");
  });

  it("cancels Copilot token exchange error bodies", async () => {
    vi.resetModules();

    const response = new Response("bad credentials", { status: 401 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async () => response);

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    await expect(
      resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl,
        cachePath: "/tmp/copilot-token.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {
          throw new Error("should not save failed token");
        },
      }),
    ).rejects.toThrow("Copilot token exchange failed: HTTP 401");

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds oversized Copilot token success body and cancels the stream", async () => {
    vi.resetModules();

    const chunk = new Uint8Array(1024 * 1024); // 1 MiB chunk
    let readCount = 0;
    let canceled = false;
    // 64 chunks × 1 MiB = 64 MiB — far exceeds the 16 MiB cap
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount >= 64) {
          controller.close();
          return;
        }
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const response = new Response(oversizedBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchImpl = vi.fn(async () => response);

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    await expect(
      resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl,
        cachePath: "/tmp/copilot-token.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {
          throw new Error("should not save oversized token");
        },
      }),
    ).rejects.toThrow("github-copilot.token");

    // Stream must be cancelled before all 64 chunks are consumed
    expect(readCount).toBeLessThan(64);
    expect(canceled).toBe(true);
  });

  it("bounds oversized Copilot token success body over HTTP transport", async () => {
    vi.resetModules();

    const http = await import("node:http");
    const { once } = await import("node:events");
    const MiB = 1024 * 1024;
    let bytesWritten = 0;

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = Buffer.alloc(MiB, 120);
      const header = Buffer.from('{"token":"');
      res.write(header);
      bytesWritten += header.length;
      let chunksSent = 0;
      const writeNext = () => {
        if (chunksSent >= 18) {
          const tail = Buffer.from('","expires_at":9999999999}');
          res.write(tail);
          bytesWritten += tail.length;
          res.end();
          return;
        }
        const ok = res.write(chunk);
        bytesWritten += chunk.length;
        chunksSent += 1;
        if (ok) {
          setImmediate(writeNext);
        } else {
          res.once("drain", writeNext);
        }
      };
      writeNext();
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected server address");
    }

    try {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}/token`, init),
      );
      const { resolveCopilotApiToken } = await import("./provider-auth.js");

      await expect(
        resolveCopilotApiToken({
          githubToken: "github-token",
          fetchImpl: fetchImpl as typeof fetch,
          cachePath: "/tmp/copilot-token-http-proof.json",
          loadJsonFileImpl: () => undefined,
          saveJsonFileImpl: () => {
            throw new Error("should not save oversized token");
          },
        }),
      ).rejects.toThrow("github-copilot.token");

      expect(bytesWritten).toBeGreaterThan(17 * MiB);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("accepts a normal Copilot token success body over HTTP transport", async () => {
    vi.resetModules();

    const http = await import("node:http");
    const { once } = await import("node:events");
    const body = JSON.stringify({
      token: "gho_abc;proxy-ep=proxy.individual.githubcopilot.com",
      expires_at: "+2000000000",
    });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected server address");
    }

    try {
      const saved: unknown[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}/token`, init),
      );
      const { resolveCopilotApiToken } = await import("./provider-auth.js");

      const result = await resolveCopilotApiToken({
        githubToken: "github-token",
        fetchImpl: fetchImpl as typeof fetch,
        cachePath: "/tmp/copilot-token-http-happy.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: (path, value) => {
          saved.push({ path, value });
        },
      });

      expect(result.token).toContain("proxy-ep=proxy.individual.githubcopilot.com");
      expect(saved).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refreshes cached Copilot tokens with out-of-range expiry values", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "fresh;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: "+2000000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      fetchImpl,
      cachePath: "/tmp/copilot-token.json",
      loadJsonFileImpl: () => ({
        token: "cached;proxy-ep=proxy.individual.githubcopilot.com",
        expiresAt: Number.MAX_SAFE_INTEGER,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
      }),
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched:https://api.github.com/copilot_internal/v2/token");
    expect(result.token).toBe("fresh;proxy-ep=proxy.individual.githubcopilot.com");
    expect(saved).toEqual([
      expect.objectContaining({
        expiresAt: 2_000_000_000_000,
        token: "fresh;proxy-ep=proxy.individual.githubcopilot.com",
      }),
    ]);
  });
});

describe("Copilot data-residency domain resolution", () => {
  afterEach(() => {
    delete process.env.COPILOT_GITHUB_DOMAIN;
  });

  it("warns once when a configured domain is rejected during token resolution", async () => {
    vi.resetModules();
    const logWarn = vi.fn();
    vi.doMock("../logger.js", async () => {
      const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
      return { ...actual, logWarn };
    });
    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "tok", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const withDomain = (githubDomain: string) =>
      ({
        models: { providers: { "github-copilot": { params: { githubDomain } } } },
      }) as never;
    const resolveWithConfigDomain = (githubDomain: string) =>
      resolveCopilotApiToken({
        githubToken: "github-token",
        env: {},
        config: withDomain(githubDomain),
        fetchImpl,
        cachePath: "/tmp/copilot-token-warn.json",
        loadJsonFileImpl: () => undefined,
        saveJsonFileImpl: () => {},
      });

    // Valid tenant + explicit public host never warn.
    await resolveWithConfigDomain("acme.ghe.com");
    await resolveWithConfigDomain("github.com");
    expect(logWarn).not.toHaveBeenCalled();

    // Typo (`.co`) fails the allowlist -> silent fallback -> warn once, not twice.
    await resolveWithConfigDomain("acme.ghe.co");
    await resolveWithConfigDomain("acme.ghe.co");
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("acme.ghe.co"));

    vi.doUnmock("../logger.js");
  });

  it("rejects unsafe hostnames and falls back to github.com", async () => {
    vi.resetModules();
    const { normalizeGithubCopilotDomain } = await import("./provider-auth.js");

    expect(normalizeGithubCopilotDomain("https://evil.com/login")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("user@host")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com")).toBe("acme.ghe.com");
    expect(normalizeGithubCopilotDomain("  ACME.GHE.COM  ")).toBe("acme.ghe.com");
  });

  it("locks the host allowlist to github.com and single-label *.ghe.com tenant roots", async () => {
    vi.resetModules();
    const { normalizeGithubCopilotDomain } = await import("./provider-auth.js");

    // Allowed: public host and single-label data-residency tenant roots.
    expect(normalizeGithubCopilotDomain("github.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com")).toBe("acme.ghe.com");

    // Rejected: derived service hosts under a tenant. GitHub documents these as
    // `*.SUBDOMAIN.ghe.com` endpoints; storing one would template broken hosts
    // like `api.api.acme.ghe.com` for the token exchange.
    expect(normalizeGithubCopilotDomain("api.acme.ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("copilot-api.acme.ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("a.b.ghe.com")).toBe("github.com");

    // Rejected: arbitrary hosts, look-alikes, and the bare non-tenant apex.
    expect(normalizeGithubCopilotDomain("evil.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("github.com.evil.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("evilghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com.evil.com")).toBe("github.com");
  });

  it("targets the tenant token endpoint and copilot-api fallback for a GHE domain", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn(
      async () =>
        // GHE data-residency tokens carry a stamp but no proxy-ep hint.
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      githubDomain: "acme.ghe.com",
      fetchImpl,
      cachePath: "/tmp/copilot-token-ghe.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => {},
    });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.acme.ghe.com/copilot_internal/v2/token");
    expect(result.source).toBe("fetched:https://api.acme.ghe.com/copilot_internal/v2/token");
    expect(result.baseUrl).toBe("https://copilot-api.acme.ghe.com");
  });

  it("lets COPILOT_GITHUB_DOMAIN override the caller-provided domain", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: { COPILOT_GITHUB_DOMAIN: "env.ghe.com" },
      githubDomain: "config.ghe.com",
      fetchImpl,
      cachePath: "/tmp/copilot-token-env.json",
      loadJsonFileImpl: () => undefined,
      saveJsonFileImpl: () => {},
    });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.env.ghe.com/copilot_internal/v2/token");
    expect(result.baseUrl).toBe("https://copilot-api.env.ghe.com");
  });

  it("does not reuse a cached token minted for a different domain", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    // A valid, unexpired public-github.com token sits in the cache, but the
    // request targets a GHE tenant, so it must be re-exchanged rather than
    // sending a github.com token to api.acme.ghe.com.
    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      githubDomain: "acme.ghe.com",
      fetchImpl,
      cachePath: "/tmp/copilot-token-cross.json",
      loadJsonFileImpl: () => ({
        token: "public;proxy-ep=proxy.individual.githubcopilot.com",
        expiresAt: Number.MAX_SAFE_INTEGER - 1,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        domain: "github.com",
      }),
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched:https://api.acme.ghe.com/copilot_internal/v2/token");
    expect(saved).toEqual([expect.objectContaining({ domain: "acme.ghe.com" })]);
  });

  it("keeps legacy pre-domain cache entries usable for github.com across upgrade", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn();
    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    // Shipped caches predate the domain stamp and were only ever minted for
    // public github.com. A valid legacy entry must stay a cache hit for the
    // default domain instead of forcing a re-exchange on upgrade.
    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath: "/tmp/copilot-token-legacy.json",
      loadJsonFileImpl: () => ({
        token: "legacy-public;proxy-ep=proxy.individual.githubcopilot.com",
        expiresAt: Date.now() + 60 * 60 * 1000,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        // no domain field
      }),
      saveJsonFileImpl: () => {},
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe("cache:/tmp/copilot-token-legacy.json");
  });

  it("does not reuse a legacy pre-domain cache entry for a tenant domain", async () => {
    vi.resetModules();

    const saved: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghe;st=prod-sdc-01", expires_at: "+2000000000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      githubDomain: "acme.ghe.com",
      fetchImpl,
      cachePath: "/tmp/copilot-token-legacy-tenant.json",
      loadJsonFileImpl: () => ({
        token: "legacy-public;proxy-ep=proxy.individual.githubcopilot.com",
        expiresAt: Date.now() + 60 * 60 * 1000,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        // no domain field — implies github.com, so a tenant request must miss
      }),
      saveJsonFileImpl: (_path, value) => saved.push(value),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched:https://api.acme.ghe.com/copilot_internal/v2/token");
    expect(saved).toEqual([expect.objectContaining({ domain: "acme.ghe.com" })]);
  });

  it("reuses a cached token minted for the same domain", async () => {
    vi.resetModules();

    const fetchImpl = vi.fn();
    const { COPILOT_INTEGRATION_ID, resolveCopilotApiToken } = await import("./provider-auth.js");

    const result = await resolveCopilotApiToken({
      githubToken: "github-token",
      env: {},
      githubDomain: "acme.ghe.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cachePath: "/tmp/copilot-token-same.json",
      loadJsonFileImpl: () => ({
        token: "tenant-cached;st=prod-sdc-01",
        expiresAt: Date.now() + 60 * 60 * 1000,
        updatedAt: Date.now(),
        integrationId: COPILOT_INTEGRATION_ID,
        domain: "acme.ghe.com",
      }),
      saveJsonFileImpl: () => {},
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe("cache:/tmp/copilot-token-same.json");
    expect(result.baseUrl).toBe("https://copilot-api.acme.ghe.com");
  });
});
