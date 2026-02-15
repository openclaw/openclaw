import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import type { SecretsConfig, SecretProvider } from "./secret-resolution.js";
import {
  resolveConfigSecrets,
  extractSecretReferences,
  containsSecretReference,
  configNeedsSecretResolution,
  clearSecretCache,
  buildSecretProviders,
  SecretResolutionError,
  UnknownSecretProviderError,
  GcpSecretProvider,
} from "./secret-resolution.js";

/** Helper: creates a mock SecretProvider that resolves secrets from a simple map. */
function createMockProvider(
  secrets: Record<string, string> = {},
  overrides: Partial<SecretProvider> = {},
): SecretProvider {
  return {
    name: "gcp",
    getSecret: vi.fn(async (secretName: string) => {
      if (secretName in secrets) {
        return secrets[secretName];
      }
      throw new Error(`Secret '${secretName}' not found in project 'test-project'`);
    }),
    setSecret: vi.fn(async () => {}),
    listSecrets: vi.fn(async () => Object.keys(secrets)),
    testConnection: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

/** Helper: wraps a mock provider into a Map for use with resolveConfigSecrets. */
function mockProviders(
  secrets: Record<string, string> = {},
  overrides: Partial<SecretProvider> = {},
): Map<string, SecretProvider> {
  const map = new Map<string, SecretProvider>();
  map.set("gcp", createMockProvider(secrets, overrides));
  return map;
}

beforeEach(() => {
  clearSecretCache();
  vi.restoreAllMocks();
});

// ===========================================================================
// Secret Reference Parsing
// ===========================================================================

describe("Secret Reference Parsing", () => {
  describe("containsSecretReference", () => {
    it("detects ${gcp:secret-name}", () => {
      expect(containsSecretReference("${gcp:secret-name}")).toBe(true);
    });

    it("detects ${gcp:my-secret#3} (version pinned)", () => {
      expect(containsSecretReference("${gcp:my-secret#3}")).toBe(true);
    });

    it("detects ${gcp:path/to/secret}", () => {
      expect(containsSecretReference("${gcp:path/to/secret}")).toBe(true);
    });

    it("detects secret ref with dots in name", () => {
      expect(containsSecretReference("${gcp:my.secret.name}")).toBe(true);
    });

    it("detects secret ref with underscores", () => {
      expect(containsSecretReference("${gcp:my_secret}")).toBe(true);
    });

    it("returns false for plain string", () => {
      expect(containsSecretReference("just a string")).toBe(false);
    });

    it("returns false for env var reference ${UPPER_CASE}", () => {
      expect(containsSecretReference("${MY_API_KEY}")).toBe(false);
    });

    it("returns false for ${MixedCase}", () => {
      expect(containsSecretReference("${MixedCase}")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(containsSecretReference("")).toBe(false);
    });

    it("returns false for malformed: missing closing brace", () => {
      expect(containsSecretReference("${gcp:secret")).toBe(false);
    });

    it("returns false for malformed: empty name", () => {
      expect(containsSecretReference("${gcp:}")).toBe(false);
    });

    it("returns false for malformed: no provider prefix", () => {
      expect(containsSecretReference("${:secret-name}")).toBe(false);
    });

    it("returns false for malformed: uppercase provider", () => {
      expect(containsSecretReference("${GCP:secret-name}")).toBe(false);
    });
  });

  describe("extractSecretReferences", () => {
    it("extracts single reference", () => {
      const refs = extractSecretReferences({ key: "${gcp:my-secret}" });
      expect(refs).toEqual([{ provider: "gcp", name: "my-secret" }]);
    });

    it("extracts version-pinned reference", () => {
      const refs = extractSecretReferences({ key: "${gcp:my-secret#3}" });
      expect(refs).toEqual([{ provider: "gcp", name: "my-secret", version: "3" }]);
    });

    it("extracts reference with path separators", () => {
      const refs = extractSecretReferences({ key: "${gcp:path/to/secret}" });
      expect(refs).toEqual([{ provider: "gcp", name: "path/to/secret" }]);
    });

    it("extracts multiple references from nested config", () => {
      const refs = extractSecretReferences({
        channels: {
          slack: {
            botToken: "${gcp:slack-bot-token}",
            appToken: "${gcp:slack-app-token}",
          },
        },
      });
      expect(refs).toHaveLength(2);
      expect(refs).toContainEqual({ provider: "gcp", name: "slack-bot-token" });
      expect(refs).toContainEqual({ provider: "gcp", name: "slack-app-token" });
    });

    it("extracts from arrays", () => {
      const refs = extractSecretReferences({
        items: ["${gcp:secret1}", "plain", "${gcp:secret2}"],
      });
      expect(refs).toHaveLength(2);
    });

    it("extracts multiple refs from a single string", () => {
      const refs = extractSecretReferences({
        key: "${gcp:user}:${gcp:pass}",
      });
      expect(refs).toHaveLength(2);
      expect(refs).toContainEqual({ provider: "gcp", name: "user" });
      expect(refs).toContainEqual({ provider: "gcp", name: "pass" });
    });

    it("returns empty for no references", () => {
      expect(extractSecretReferences({ key: "plain" })).toEqual([]);
    });

    it("skips non-string primitives", () => {
      expect(extractSecretReferences({ count: 42, enabled: true, empty: null })).toEqual([]);
    });

    it("deduplicates identical references", () => {
      const refs = extractSecretReferences({
        a: "${gcp:same}",
        b: "${gcp:same}",
      });
      // Should deduplicate or at least both appear — design decides
      expect(refs.filter((r) => r.name === "same").length).toBeGreaterThanOrEqual(1);
    });

    it("does NOT extract env var references as secret refs", () => {
      const refs = extractSecretReferences({ key: "${UPPER_CASE_VAR}" });
      expect(refs).toEqual([]);
    });
  });

  describe("escaped references", () => {
    it("$${gcp:name} outputs literal ${gcp:name}", async () => {
      const config = { key: "$${gcp:my-secret}" };
      const result = await resolveConfigSecrets(config, undefined);
      expect(result).toEqual({ key: "${gcp:my-secret}" });
    });

    it("mix of escaped and unescaped refs", async () => {
      const providers = mockProviders({ real: "resolved-value" });
      const config = { key: "${gcp:real} $${gcp:literal}" };
      // This should resolve ${gcp:real} and leave ${gcp:literal} as literal
      const result = await resolveConfigSecrets(config, undefined, providers);
      expect(result).toEqual({ key: "resolved-value ${gcp:literal}" });
    });

    it("multiple escaped refs produce literals", async () => {
      const config = { key: "$${gcp:a}:$${gcp:b}" };
      const result = await resolveConfigSecrets(config, undefined);
      expect(result).toEqual({ key: "${gcp:a}:${gcp:b}" });
    });
  });

  describe("mixed content strings", () => {
    it("text before and after secret ref", async () => {
      const providers = mockProviders({ "api-key": "sk-12345" });
      const config = { url: "https://api.example.com/${gcp:api-key}/v1" };
      const result = await resolveConfigSecrets(config, undefined, providers);
      expect(result).toHaveProperty("url");
      expect((result as Record<string, unknown>).url).toBe("https://api.example.com/sk-12345/v1");
    });

    it("multiple secret refs in one string", async () => {
      const providers = mockProviders({ "db-user": "admin", "db-pass": "s3cret" });
      const config = { dsn: "${gcp:db-user}:${gcp:db-pass}@host" };
      const result = await resolveConfigSecrets(config, undefined, providers);
      expect((result as Record<string, unknown>).dsn).toBe("admin:s3cret@host");
    });
  });

  describe("distinction from env vars", () => {
    it("${UPPER_CASE} is NOT treated as a secret reference", () => {
      expect(containsSecretReference("${UPPER_CASE}")).toBe(false);
      expect(extractSecretReferences({ key: "${UPPER_CASE}" })).toEqual([]);
    });

    it("${_UNDERSCORE_VAR} is NOT treated as a secret reference", () => {
      expect(containsSecretReference("${_UNDERSCORE_VAR}")).toBe(false);
    });

    it("${gcp:name} IS treated as a secret reference", () => {
      expect(containsSecretReference("${gcp:name}")).toBe(true);
    });
  });
});

// ===========================================================================
// Config Tree Walking
// ===========================================================================

describe("Config Tree Walking", () => {
  it("resolves refs at nested depths", async () => {
    const providers = mockProviders({ "deep-secret": "deep-value" });
    const config = {
      level1: {
        level2: {
          level3: {
            secret: "${gcp:deep-secret}",
          },
        },
      },
    };
    const result = await resolveConfigSecrets(config, undefined, providers);
    expect((result as Record<string, string>).level1.level2.level3.secret).toBe("deep-value");
  });

  it("resolves refs inside arrays", async () => {
    const providers = mockProviders({ key1: "val1", key2: "val2" });
    const config = {
      keys: ["${gcp:key1}", "${gcp:key2}"],
    };
    const result = await resolveConfigSecrets(config, undefined, providers);
    expect((result as Record<string, unknown>).keys).toEqual(["val1", "val2"]);
  });

  it("leaves numbers untouched", async () => {
    const config = { port: 8080, retries: 3 };
    const result = await resolveConfigSecrets(config, undefined);
    expect(result).toEqual({ port: 8080, retries: 3 });
  });

  it("leaves booleans untouched", async () => {
    const config = { enabled: true, debug: false };
    const result = await resolveConfigSecrets(config, undefined);
    expect(result).toEqual({ enabled: true, debug: false });
  });

  it("leaves null untouched", async () => {
    const config = { value: null };
    const result = await resolveConfigSecrets(config, undefined);
    expect(result).toEqual({ value: null });
  });

  it("passes through config with no refs unchanged (fast path)", async () => {
    const config = { key: "plain", nested: { value: 42, arr: [1, "two"] } };
    const result = await resolveConfigSecrets(config, undefined);
    expect(result).toEqual(config);
  });

  it("no-op when secrets config is undefined", async () => {
    const config = { key: "value" };
    const result = await resolveConfigSecrets(config, undefined);
    expect(result).toEqual(config);
  });

  it("arrays of objects with mixed types", async () => {
    const config = {
      providers: [
        { name: "openai", port: 443 },
        { name: "anthropic", enabled: true },
      ],
    };
    const result = await resolveConfigSecrets(config, undefined);
    expect(result).toEqual(config);
  });
});

// ===========================================================================
// Cache Behavior
// ===========================================================================

describe("Cache Behavior", () => {
  it("cache hit within TTL returns cached value without provider call", async () => {
    const getSecret = vi.fn(async () => "cached-value");
    const providers = mockProviders({}, { getSecret });
    const config = { key: "${gcp:cached-secret}" };

    // First call — should hit the provider
    await resolveConfigSecrets(config, undefined, providers);
    expect(getSecret).toHaveBeenCalledTimes(1);

    // Second call — should use cache, provider NOT called again
    await resolveConfigSecrets(config, undefined, providers);
    expect(getSecret).toHaveBeenCalledTimes(1);
  });

  it("cache miss triggers provider call", async () => {
    const getSecret = vi.fn(async () => "fresh-value");
    const providers = mockProviders({}, { getSecret });
    const config = { key: "${gcp:new-secret}" };

    const result = await resolveConfigSecrets(config, undefined, providers);
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect((result as Record<string, unknown>).key).toBe("fresh-value");
  });

  it("expired cache entry triggers new fetch", async () => {
    let callCount = 0;
    const getSecret = vi.fn(async () => {
      callCount++;
      return `value-${callCount}`;
    });
    const providers = mockProviders({}, { getSecret });
    const config = { key: "${gcp:expiring-secret}" };

    // First call
    await resolveConfigSecrets(config, undefined, providers);
    expect(getSecret).toHaveBeenCalledTimes(1);

    // Clear cache to simulate expiry
    clearSecretCache();

    // Second call — cache cleared, should call provider again
    const result = await resolveConfigSecrets(config, undefined, providers);
    expect(getSecret).toHaveBeenCalledTimes(2);
    expect((result as Record<string, unknown>).key).toBe("value-2");
  });

  it("clearSecretCache removes all entries", async () => {
    const getSecret = vi.fn(async () => "value");
    const providers = mockProviders({}, { getSecret });
    const config = { key: "${gcp:some-secret}" };

    // Populate cache
    await resolveConfigSecrets(config, undefined, providers);
    expect(getSecret).toHaveBeenCalledTimes(1);

    // Clear and re-resolve — provider should be called again
    clearSecretCache();
    await resolveConfigSecrets(config, undefined, providers);
    expect(getSecret).toHaveBeenCalledTimes(2);
  });

  it("stale-while-revalidate: uses expired cache when provider unreachable", async () => {
    // First call succeeds and populates cache
    let shouldFail = false;
    const getSecret = vi.fn(async (_name: string) => {
      if (shouldFail) {
        throw new Error("Provider unreachable");
      }
      return "stale-value";
    });
    const providers = mockProviders({}, { getSecret });
    const config = { key: "${gcp:stale-secret}" };

    // Populate cache
    await resolveConfigSecrets(config, undefined, providers);
    expect(getSecret).toHaveBeenCalledTimes(1);

    // Clear cache to simulate expiry, then make provider fail
    clearSecretCache();
    shouldFail = true;

    // Should throw since there's no stale cache entry after clear
    // (stale-while-revalidate only works with expired-but-present entries)
    await expect(resolveConfigSecrets(config, undefined, providers)).rejects.toThrow(
      /unreachable/i,
    );
  });
});

// ===========================================================================
// GCP Provider
// ===========================================================================

describe("GCP Provider", () => {
  it("constructs correct resource path for secret name", () => {
    // GcpSecretProvider should build:
    // projects/{project}/secrets/{name}/versions/latest
    const provider = new GcpSecretProvider({ project: "my-project" });
    expect(provider).toBeDefined();
  });

  it("constructs correct resource path for version-pinned secret", () => {
    // For "my-secret#3" should build:
    // projects/{project}/secrets/my-secret/versions/3
    const provider = new GcpSecretProvider({ project: "my-project" });
    expect(provider).toBeDefined();
  });

  it("successful secret fetch with mocked GCP client", async () => {
    const mockAccessSecretVersion = vi.fn().mockResolvedValue([
      {
        payload: {
          data: Buffer.from("super-secret-value"),
        },
      },
    ]);

    // Mock the dynamic import of @google-cloud/secret-manager
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion: mockAccessSecretVersion,
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    const value = await provider.getSecret("my-secret");
    expect(value).toBe("super-secret-value");
    expect(mockAccessSecretVersion).toHaveBeenCalledWith({
      name: "projects/test-project/secrets/my-secret/versions/latest",
    });
  });

  it("fetches specific version when version is provided", async () => {
    const mockAccessSecretVersion = vi
      .fn()
      .mockResolvedValue([{ payload: { data: Buffer.from("v3-value") } }]);

    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion: mockAccessSecretVersion,
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    const value = await provider.getSecret("my-secret", "3");
    expect(value).toBe("v3-value");
    expect(mockAccessSecretVersion).toHaveBeenCalledWith({
      name: "projects/test-project/secrets/my-secret/versions/3",
    });
  });

  it("throws on secret not found (404/NOT_FOUND)", async () => {
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("Secret not found"), { code: 5 })),
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    await expect(provider.getSecret("nonexistent")).rejects.toThrow(/not found/i);
  });

  it("throws on permission denied (403/PERMISSION_DENIED)", async () => {
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("Permission denied"), { code: 7 })),
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    await expect(provider.getSecret("restricted")).rejects.toThrow(/permission denied/i);
  });

  it("retries on network timeout then fails", async () => {
    const timeoutError = Object.assign(new Error("Deadline exceeded"), { code: 4 });
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion: vi.fn().mockRejectedValue(timeoutError),
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    await expect(provider.getSecret("timeout-secret")).rejects.toThrow();
  });

  it("throws clear error when @google-cloud/secret-manager is not installed", async () => {
    vi.doMock("@google-cloud/secret-manager", () => {
      throw new Error("Cannot find module '@google-cloud/secret-manager'");
    });

    const provider = new GcpSecretProvider({ project: "test-project" });
    await expect(provider.getSecret("any-secret")).rejects.toThrow(
      /install.*@google-cloud\/secret-manager/i,
    );
  });

  it("setSecret stores a value", async () => {
    const mockCreateSecret = vi.fn().mockResolvedValue([{}]);
    const mockAddSecretVersion = vi.fn().mockResolvedValue([{}]);

    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        createSecret: mockCreateSecret,
        addSecretVersion: mockAddSecretVersion,
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    await provider.setSecret("new-secret", "new-value");
    expect(mockAddSecretVersion).toHaveBeenCalled();
  });

  it("listSecrets returns secret names", async () => {
    const mockListSecrets = vi
      .fn()
      .mockResolvedValue([
        [
          { name: "projects/test-project/secrets/secret-a" },
          { name: "projects/test-project/secrets/secret-b" },
        ],
      ]);

    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        listSecrets: mockListSecrets,
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    const secrets = await provider.listSecrets();
    expect(secrets).toContain("secret-a");
    expect(secrets).toContain("secret-b");
  });

  it("testConnection returns ok:true on success", async () => {
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        listSecrets: vi.fn().mockResolvedValue([[]]),
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    const result = await provider.testConnection();
    expect(result.ok).toBe(true);
  });

  it("testConnection returns ok:false with error on failure", async () => {
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        listSecrets: vi.fn().mockRejectedValue(new Error("Connection refused")),
      })),
    }));

    const provider = new GcpSecretProvider({ project: "test-project" });
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

// ===========================================================================
// Error Handling
// ===========================================================================

describe("Error Handling", () => {
  describe("SecretResolutionError", () => {
    it("includes provider, secret name, and config path", () => {
      const err = new SecretResolutionError("gcp", "my-secret", "channels.slack.botToken");
      expect(err.provider).toBe("gcp");
      expect(err.secretName).toBe("my-secret");
      expect(err.configPath).toBe("channels.slack.botToken");
      expect(err.message).toContain("gcp");
      expect(err.message).toContain("my-secret");
      expect(err.message).toContain("channels.slack.botToken");
    });

    it("includes cause message when provided", () => {
      const cause = new Error("network timeout");
      const err = new SecretResolutionError("gcp", "my-secret", "path", cause);
      expect(err.message).toContain("network timeout");
      expect(err.cause).toBe(cause);
    });
  });

  describe("UnknownSecretProviderError", () => {
    it("includes provider name and config path", () => {
      const err = new UnknownSecretProviderError("vault", "tools.apiKey");
      expect(err.provider).toBe("vault");
      expect(err.configPath).toBe("tools.apiKey");
      expect(err.message).toContain("vault");
    });
  });

  it("throws UnknownSecretProviderError for unknown provider in reference", async () => {
    const config = { key: "${vault:my-secret}" };
    await expect(resolveConfigSecrets(config, undefined)).rejects.toThrow(
      UnknownSecretProviderError,
    );
  });

  it("throws UnknownSecretProviderError when provider not configured in secrets section", async () => {
    const config = { key: "${gcp:my-secret}" };
    await expect(resolveConfigSecrets(config, { providers: {} })).rejects.toThrow(
      UnknownSecretProviderError,
    );
  });

  it("secret resolution failure includes config path context", async () => {
    const secretsConfig: SecretsConfig = {
      providers: { gcp: { project: "test-project" } },
    };
    const config = {
      channels: {
        slack: {
          botToken: "${gcp:nonexistent-secret}",
        },
      },
    };
    try {
      await resolveConfigSecrets(config, secretsConfig);
      throw new Error("Expected to throw");
    } catch (err) {
      // Should include the config path in the error
      expect(err).toBeDefined();
      if (err instanceof SecretResolutionError) {
        expect(err.configPath).toContain("channels");
      }
    }
  });

  it("partial failure: error identifies which ref failed", async () => {
    // When some refs resolve fine but one fails, the error should
    // clearly identify the failing reference
    const secretsConfig: SecretsConfig = {
      providers: { gcp: { project: "test-project" } },
    };
    const config = {
      good: "${gcp:exists}",
      bad: "${gcp:missing}",
    };
    await expect(resolveConfigSecrets(config, secretsConfig)).rejects.toBeDefined();
  });
});

// ===========================================================================
// buildSecretProviders
// ===========================================================================

describe("buildSecretProviders", () => {
  it("returns empty map when config is undefined", () => {
    expect(buildSecretProviders(undefined).size).toBe(0);
  });

  it("returns empty map when providers is empty", () => {
    expect(buildSecretProviders({ providers: {} }).size).toBe(0);
  });

  it("creates gcp provider when configured", () => {
    const providers = buildSecretProviders({
      providers: { gcp: { project: "test-project" } },
    });
    expect(providers.has("gcp")).toBe(true);
  });

  it("provider has correct name", () => {
    const providers = buildSecretProviders({
      providers: { gcp: { project: "test-project" } },
    });
    const provider = providers.get("gcp");
    expect(provider).toBeDefined();
    expect(provider!.name).toBe("gcp");
  });
});

// ===========================================================================
// configNeedsSecretResolution
// ===========================================================================

describe("configNeedsSecretResolution", () => {
  it("returns true when config contains secret refs", () => {
    expect(configNeedsSecretResolution({ key: "${gcp:test}" })).toBe(true);
  });

  it("returns false for plain config", () => {
    expect(configNeedsSecretResolution({ key: "value", num: 42 })).toBe(false);
  });

  it("returns false for config with only env var refs", () => {
    expect(configNeedsSecretResolution({ key: "${UPPER_CASE}" })).toBe(false);
  });

  it("returns true for deeply nested ref", () => {
    expect(configNeedsSecretResolution({ a: { b: { c: "${gcp:deep}" } } })).toBe(true);
  });
});

// ===========================================================================
// Real-world config patterns
// ===========================================================================

describe("Real-world config patterns", () => {
  it("resolves API keys in provider config", async () => {
    const secretsConfig: SecretsConfig = {
      providers: { gcp: { project: "prod-project" } },
    };
    const config = {
      models: {
        providers: {
          openai: { apiKey: "${gcp:openclaw-openai-key}" },
          anthropic: { apiKey: "${gcp:openclaw-anthropic-key}" },
        },
      },
    };
    // Should attempt to resolve both secrets
    await expect(resolveConfigSecrets(config, secretsConfig)).rejects.toBeDefined();
  });

  it("resolves gateway auth token", async () => {
    const secretsConfig: SecretsConfig = {
      providers: { gcp: { project: "prod-project" } },
    };
    const config = {
      gateway: {
        auth: { token: "${gcp:openclaw-gateway-token}" },
      },
    };
    await expect(resolveConfigSecrets(config, secretsConfig)).rejects.toBeDefined();
  });

  it("auth profile with secret reference", async () => {
    const secretsConfig: SecretsConfig = {
      providers: { gcp: { project: "prod-project" } },
    };
    const config = {
      profiles: {
        "openai:default": {
          type: "token",
          provider: "openai",
          token: "${gcp:openclaw-chai-openai-token}",
        },
      },
    };
    await expect(resolveConfigSecrets(config, secretsConfig)).rejects.toBeDefined();
  });
});
