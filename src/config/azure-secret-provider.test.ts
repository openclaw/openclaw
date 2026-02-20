import { describe, expect, it, vi } from "vitest";
import {
  AzureSecretProvider,
  validateAzureSecretName,
  parseAzureRotationTags,
  buildAzureRotationTags,
  checkSecretVersionChanged,
  type AzureSecretClient,
  type AzureSecretConfig,
  type AzureRotationMetadata,
} from "./azure-secret-provider.js";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function createMockClient(
  secrets: Record<string, { value: string; version?: string; tags?: Record<string, string> }> = {},
): AzureSecretClient {
  return {
    getSecret: vi.fn(async (name: string, opts?: { version?: string }) => {
      const entry = secrets[name];
      if (!entry) {
        const err = new Error(`Secret '${name}' not found`) as Error & {
          statusCode: number;
          code: string;
        };
        err.statusCode = 404;
        err.code = "SecretNotFound";
        throw err;
      }
      return {
        value: entry.value,
        properties: { version: opts?.version ?? entry.version ?? "v1", tags: entry.tags ?? {} },
      };
    }),
    setSecret: vi.fn(async (_name: string, _value: string) => ({
      properties: { version: "v2" },
    })),
    listPropertiesOfSecrets: vi.fn(function () {
      const names = Object.keys(secrets);
      let i = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (i < names.length) {
                return { value: { name: names[i++] }, done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
    }),
  };
}

function makeProvider(
  client: AzureSecretClient,
  configOverrides?: Partial<AzureSecretConfig>,
): AzureSecretProvider {
  return new AzureSecretProvider(
    { vaultUrl: "https://test-vault.vault.azure.net", ...configOverrides },
    client,
  );
}

// ===========================================================================
// Name Validation
// ===========================================================================

describe("validateAzureSecretName", () => {
  it("accepts valid names", () => {
    expect(() => validateAzureSecretName("my-secret")).not.toThrow();
    expect(() => validateAzureSecretName("MySecret123")).not.toThrow();
    expect(() => validateAzureSecretName("a")).not.toThrow();
  });

  it("rejects names with underscores", () => {
    expect(() => validateAzureSecretName("my_secret")).toThrow(/only allow alphanumeric/);
  });

  it("rejects names with dots", () => {
    expect(() => validateAzureSecretName("my.secret")).toThrow(/only allow alphanumeric/);
  });

  it("rejects names with slashes", () => {
    expect(() => validateAzureSecretName("path/to/secret")).toThrow(/only allow alphanumeric/);
  });

  it("rejects empty string", () => {
    expect(() => validateAzureSecretName("")).toThrow(/only allow alphanumeric/);
  });
});

// ===========================================================================
// AzureSecretProvider
// ===========================================================================

describe("AzureSecretProvider", () => {
  describe("constructor / properties", () => {
    it("has name 'azure'", () => {
      const provider = makeProvider(createMockClient());
      expect(provider.name).toBe("azure");
    });

    it("defaults cacheTtl to 300s", () => {
      const provider = makeProvider(createMockClient());
      expect(provider.cacheTtlMillis).toBe(300_000);
    });

    it("respects custom cacheTtlSeconds", () => {
      const provider = makeProvider(createMockClient(), { cacheTtlSeconds: 60 });
      expect(provider.cacheTtlMillis).toBe(60_000);
    });
  });

  describe("getSecret", () => {
    it("resolves a secret by name", async () => {
      const client = createMockClient({ "my-secret": { value: "s3cret" } });
      const provider = makeProvider(client);

      const val = await provider.getSecret("my-secret");
      expect(val).toBe("s3cret");
      expect(vi.mocked(client.getSecret)).toHaveBeenCalledWith("my-secret", undefined);
    });

    it("resolves a versioned secret", async () => {
      const client = createMockClient({ "my-secret": { value: "old-val", version: "v1" } });
      const provider = makeProvider(client);

      await provider.getSecret("my-secret", "v1");
      expect(vi.mocked(client.getSecret)).toHaveBeenCalledWith("my-secret", { version: "v1" });
    });

    it("throws on not found (404)", async () => {
      const client = createMockClient({});
      const provider = makeProvider(client);

      await expect(provider.getSecret("missing")).rejects.toThrow(
        "Secret 'missing' not found in vault",
      );
    });

    it("throws on permission denied (403)", async () => {
      const client = createMockClient({});
      (client.getSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error("Forbidden"), { statusCode: 403, code: "Forbidden" }),
      );
      const provider = makeProvider(client);

      await expect(provider.getSecret("restricted")).rejects.toThrow(/Permission denied/);
    });

    it("throws on CredentialUnavailableError", async () => {
      const client = createMockClient({});
      (client.getSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error("No creds"), { code: "CredentialUnavailableError" }),
      );
      const provider = makeProvider(client);

      await expect(provider.getSecret("any-secret")).rejects.toThrow(/az login/);
    });

    it("throws on undefined value", async () => {
      const client = createMockClient({});
      (client.getSecret as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        value: undefined,
        properties: { version: "v1" },
      });
      const provider = makeProvider(client);

      await expect(provider.getSecret("empty-secret")).rejects.toThrow(/has no value/);
    });

    it("validates secret name before fetching", async () => {
      const client = createMockClient({});
      const provider = makeProvider(client);

      await expect(provider.getSecret("invalid_name")).rejects.toThrow(/only allow alphanumeric/);
      expect(vi.mocked(client.getSecret)).not.toHaveBeenCalled();
    });
  });

  describe("setSecret", () => {
    it("stores a secret", async () => {
      const client = createMockClient({});
      const provider = makeProvider(client);

      await provider.setSecret("new-secret", "value123");
      expect(vi.mocked(client.setSecret)).toHaveBeenCalledWith("new-secret", "value123");
    });

    it("validates name before storing", async () => {
      const client = createMockClient({});
      const provider = makeProvider(client);

      await expect(provider.setSecret("bad.name", "val")).rejects.toThrow(
        /only allow alphanumeric/,
      );
      expect(vi.mocked(client.setSecret)).not.toHaveBeenCalled();
    });
  });

  describe("listSecrets", () => {
    it("returns all secret names", async () => {
      const client = createMockClient({
        "secret-a": { value: "a" },
        "secret-b": { value: "b" },
      });
      const provider = makeProvider(client);

      const names = await provider.listSecrets();
      expect(names).toEqual(["secret-a", "secret-b"]);
    });

    it("returns empty array when no secrets", async () => {
      const client = createMockClient({});
      const provider = makeProvider(client);

      const names = await provider.listSecrets();
      expect(names).toEqual([]);
    });
  });

  describe("testConnection", () => {
    it("returns ok:true on success", async () => {
      const client = createMockClient({ s: { value: "v" } });
      const provider = makeProvider(client);

      const result = await provider.testConnection();
      expect(result).toEqual({ ok: true });
    });

    it("returns ok:false with error message on failure", async () => {
      const client = createMockClient({});
      (client.listPropertiesOfSecrets as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error("Connection refused");
            },
          };
        },
      });
      const provider = makeProvider(client);

      const result = await provider.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Connection refused");
    });
  });

  describe("SDK not installed", () => {
    it("throws helpful message when @azure/identity is missing", async () => {
      // Create provider without client override — will try real import
      const provider = new AzureSecretProvider({
        vaultUrl: "https://test.vault.azure.net",
      });

      await expect(provider.getSecret("test")).rejects.toThrow(/pnpm add/);
    });
  });
});

// ===========================================================================
// Rotation Tags
// ===========================================================================

describe("Azure Rotation Tags", () => {
  describe("parseAzureRotationTags", () => {
    it("parses complete tags", () => {
      const tags = {
        "rotation-type": "manual",
        "rotation-interval-days": "30",
        "last-rotated": "2026-01-15T10:00:00.000Z",
        "expires-at": "2026-04-15T10:00:00.000Z",
      };
      const meta = parseAzureRotationTags(tags);
      expect(meta.rotationType).toBe("manual");
      expect(meta.rotationIntervalDays).toBe(30);
      expect(meta.lastRotated).toEqual(new Date("2026-01-15T10:00:00.000Z"));
      expect(meta.expiresAt).toEqual(new Date("2026-04-15T10:00:00.000Z"));
    });

    it("defaults to manual/90 days for empty tags", () => {
      const meta = parseAzureRotationTags({});
      expect(meta.rotationType).toBe("manual");
      expect(meta.rotationIntervalDays).toBe(90);
      expect(meta.lastRotated).toBeUndefined();
    });

    it("handles auto rotation type", () => {
      const meta = parseAzureRotationTags({ "rotation-type": "auto" });
      expect(meta.rotationType).toBe("auto");
    });

    it("handles invalid dates gracefully", () => {
      const meta = parseAzureRotationTags({ "last-rotated": "not-a-date" });
      expect(meta.lastRotated).toBeUndefined();
    });

    it("handles invalid interval gracefully", () => {
      const meta = parseAzureRotationTags({ "rotation-interval-days": "abc" });
      expect(meta.rotationIntervalDays).toBe(90);
    });

    it("handles negative interval gracefully", () => {
      const meta = parseAzureRotationTags({ "rotation-interval-days": "-5" });
      expect(meta.rotationIntervalDays).toBe(90);
    });
  });

  describe("buildAzureRotationTags", () => {
    it("builds tags from metadata", () => {
      const meta: AzureRotationMetadata = {
        rotationType: "manual",
        rotationIntervalDays: 30,
        lastRotated: new Date("2026-01-15T10:00:00.000Z"),
      };
      const tags = buildAzureRotationTags(meta);
      expect(tags["rotation-type"]).toBe("manual");
      expect(tags["rotation-interval-days"]).toBe("30");
      expect(tags["last-rotated"]).toBe("2026-01-15T10:00:00.000Z");
      expect(tags["expires-at"]).toBeUndefined();
    });

    it("round-trips through parse", () => {
      const original: AzureRotationMetadata = {
        rotationType: "dynamic",
        rotationIntervalDays: 7,
        lastRotated: new Date("2026-02-01T00:00:00.000Z"),
        expiresAt: new Date("2026-03-01T00:00:00.000Z"),
        snoozedUntil: new Date("2026-02-10T00:00:00.000Z"),
      };
      const tags = buildAzureRotationTags(original);
      const parsed = parseAzureRotationTags(tags);
      expect(parsed).toEqual(original);
    });
  });
});

// ===========================================================================
// Rotation Detection (Version Polling)
// ===========================================================================

describe("checkSecretVersionChanged", () => {
  it("detects version change", async () => {
    const client = createMockClient({ "my-secret": { value: "new", version: "v2" } });
    const result = await checkSecretVersionChanged(client, "my-secret", "v1");
    expect(result.changed).toBe(true);
    expect(result.currentVersion).toBe("v2");
  });

  it("returns false when version matches", async () => {
    const client = createMockClient({ "my-secret": { value: "val", version: "v1" } });
    const result = await checkSecretVersionChanged(client, "my-secret", "v1");
    expect(result.changed).toBe(false);
  });

  it("returns false when no cached version", async () => {
    const client = createMockClient({ "my-secret": { value: "val", version: "v1" } });
    const result = await checkSecretVersionChanged(client, "my-secret", undefined);
    expect(result.changed).toBe(false);
    expect(result.currentVersion).toBe("v1");
  });
});

// ===========================================================================
// SecretProvider interface compliance
// ===========================================================================

describe("SecretProvider interface compliance", () => {
  it("implements all required methods", () => {
    const provider = makeProvider(createMockClient());
    expect(typeof provider.getSecret).toBe("function");
    expect(typeof provider.setSecret).toBe("function");
    expect(typeof provider.listSecrets).toBe("function");
    expect(typeof provider.testConnection).toBe("function");
    expect(provider.name).toBe("azure");
  });
});
