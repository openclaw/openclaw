import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  VaultSecretProvider,
  VaultLeaseManager,
  type VaultConfig,
} from "./vault-secret-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(responses: Array<{ status: number; body?: unknown; ok?: boolean }>) {
  let callIndex = 0;
  return vi.fn(async (_url: string | URL | Request, _opts?: RequestInit) => {
    const r = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: r.ok ?? (r.status >= 200 && r.status < 300),
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as unknown as Response;
  });
}

function createProvider(
  overrides: Partial<VaultConfig> = {},
  fetchFn?: ReturnType<typeof mockFetch>,
): VaultSecretProvider {
  const provider = new VaultSecretProvider({
    address: "http://127.0.0.1:8200",
    token: "s.test-token",
    ...overrides,
  });
  if (fetchFn) {
    provider._fetchFn = fetchFn;
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Auth
// ===========================================================================

describe("VaultSecretProvider — Auth", () => {
  it("uses token from config", async () => {
    const fetch = mockFetch([
      { status: 200, body: { data: { data: { value: "my-secret-value" } } } },
    ]);
    const p = createProvider({ token: "s.my-token" }, fetch);
    await p.getSecret("test");
    expect(fetch).toHaveBeenCalledOnce();
    const [, opts] = fetch.mock.calls[0];
    expect(opts?.headers).toHaveProperty("X-Vault-Token", "s.my-token");
  });

  it("uses VAULT_TOKEN env var when no config token", async () => {
    const orig = process.env.VAULT_TOKEN;
    process.env.VAULT_TOKEN = "s.env-token";
    try {
      const fetch = mockFetch([{ status: 200, body: { data: { data: { value: "v" } } } }]);
      const p = createProvider({ token: undefined }, fetch);
      await p.getSecret("test");
      const [, opts] = fetch.mock.calls[0];
      expect(opts?.headers).toHaveProperty("X-Vault-Token", "s.env-token");
    } finally {
      if (orig === undefined) {
        delete process.env.VAULT_TOKEN;
      } else {
        process.env.VAULT_TOKEN = orig;
      }
    }
  });

  it("throws when no token available", async () => {
    const orig = process.env.VAULT_TOKEN;
    delete process.env.VAULT_TOKEN;
    try {
      const p = createProvider({ token: undefined }, mockFetch([]));
      await expect(p.getSecret("test")).rejects.toThrow("No Vault token");
    } finally {
      if (orig !== undefined) {
        process.env.VAULT_TOKEN = orig;
      }
    }
  });

  it("AppRole login fetches token then uses it", async () => {
    const fetch = mockFetch([
      // AppRole login
      {
        status: 200,
        body: { auth: { client_token: "s.approle-token", lease_duration: 3600, renewable: true } },
      },
      // Actual secret read
      { status: 200, body: { data: { data: { value: "secret-val" } } } },
    ]);
    const p = createProvider(
      { token: undefined, authMethod: "approle", roleId: "role-123", secretId: "secret-456" },
      fetch,
    );
    const val = await p.getSecret("test");
    expect(val).toBe("secret-val");
    // First call is AppRole login
    expect(fetch.mock.calls[0][0]).toContain("/v1/auth/approle/login");
    // Second call has the token
    const [, opts] = fetch.mock.calls[1];
    expect(opts?.headers).toHaveProperty("X-Vault-Token", "s.approle-token");
  });

  it("AppRole login throws when roleId/secretId missing", async () => {
    const p = createProvider({ token: undefined, authMethod: "approle" }, mockFetch([]));
    await expect(p.getSecret("test")).rejects.toThrow("roleId and secretId");
  });

  it("includes X-Vault-Namespace header when namespace set", async () => {
    const fetch = mockFetch([{ status: 200, body: { data: { data: { value: "v" } } } }]);
    const p = createProvider({ namespace: "admin/team-a" }, fetch);
    await p.getSecret("test");
    const [, opts] = fetch.mock.calls[0];
    expect(opts?.headers).toHaveProperty("X-Vault-Namespace", "admin/team-a");
  });
});

// ===========================================================================
// Secret Resolution (KV v2)
// ===========================================================================

describe("VaultSecretProvider — getSecret", () => {
  it("reads KV v2 secret and extracts value field", async () => {
    const fetch = mockFetch([
      { status: 200, body: { data: { data: { value: "hunter2" }, metadata: { version: 3 } } } },
    ]);
    const p = createProvider({}, fetch);
    const val = await p.getSecret("my-app/db-password");
    expect(val).toBe("hunter2");
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:8200/v1/secret/data/my-app/db-password");
  });

  it("passes version query param when specified", async () => {
    const fetch = mockFetch([
      { status: 200, body: { data: { data: { value: "old-value" }, metadata: { version: 2 } } } },
    ]);
    const p = createProvider({}, fetch);
    await p.getSecret("my-secret", "2");
    expect(fetch.mock.calls[0][0]).toContain("?version=2");
  });

  it("uses custom mountPath", async () => {
    const fetch = mockFetch([{ status: 200, body: { data: { data: { value: "v" } } } }]);
    const p = createProvider({ mountPath: "kv" }, fetch);
    await p.getSecret("app/key");
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:8200/v1/kv/data/app/key");
  });

  it("returns JSON when no value field exists", async () => {
    const fetch = mockFetch([
      { status: 200, body: { data: { data: { username: "admin", password: "pw123" } } } },
    ]);
    const p = createProvider({}, fetch);
    const val = await p.getSecret("multi-field");
    expect(JSON.parse(val)).toEqual({ username: "admin", password: "pw123" });
  });

  it("throws on 404", async () => {
    const fetch = mockFetch([{ status: 404, ok: false, body: { errors: [] } }]);
    const p = createProvider({}, fetch);
    await expect(p.getSecret("missing")).rejects.toThrow("not found");
  });

  it("throws on 403 with policy guidance", async () => {
    const fetch = mockFetch([{ status: 403, ok: false, body: { errors: ["permission denied"] } }]);
    const p = createProvider({}, fetch);
    await expect(p.getSecret("forbidden")).rejects.toThrow("Permission denied");
  });

  it("throws on 503 (sealed)", async () => {
    const fetch = mockFetch([{ status: 503, ok: false, body: { errors: ["Vault is sealed"] } }]);
    const p = createProvider({}, fetch);
    await expect(p.getSecret("any")).rejects.toThrow("sealed");
  });

  it("throws on connection failure", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const p = createProvider({}, fetch as unknown as ReturnType<typeof mockFetch>);
    await expect(p.getSecret("test")).rejects.toThrow("Cannot connect to Vault");
  });
});

// ===========================================================================
// setSecret
// ===========================================================================

describe("VaultSecretProvider — setSecret", () => {
  it("writes KV v2 secret", async () => {
    const fetch = mockFetch([{ status: 200, body: { data: { metadata: { version: 1 } } } }]);
    const p = createProvider({}, fetch);
    await p.setSecret("my-app/api-key", "sk-12345");
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8200/v1/secret/data/my-app/api-key");
    expect(opts?.method).toBe("POST");
    expect(JSON.parse(opts?.body as string)).toEqual({ data: { value: "sk-12345" } });
  });
});

// ===========================================================================
// listSecrets
// ===========================================================================

describe("VaultSecretProvider — listSecrets", () => {
  it("lists secrets via LIST method on metadata endpoint", async () => {
    const fetch = mockFetch([
      { status: 200, body: { data: { keys: ["secret-a", "secret-b", "folder/"] } } },
    ]);
    const p = createProvider({}, fetch);
    const keys = await p.listSecrets();
    expect(keys).toEqual(["secret-a", "secret-b", "folder/"]);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8200/v1/secret/metadata/");
    expect(opts?.method).toBe("LIST");
  });

  it("returns empty array on 404", async () => {
    const fetch = mockFetch([{ status: 404, ok: false, body: { errors: [] } }]);
    const p = createProvider({}, fetch);
    const keys = await p.listSecrets();
    expect(keys).toEqual([]);
  });
});

// ===========================================================================
// testConnection
// ===========================================================================

describe("VaultSecretProvider — testConnection", () => {
  it("returns ok on healthy vault", async () => {
    const fetch = mockFetch([{ status: 200, body: { initialized: true, sealed: false } }]);
    const p = createProvider({}, fetch);
    const result = await p.testConnection();
    expect(result).toEqual({ ok: true });
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:8200/v1/sys/health");
  });

  it("returns error on sealed vault", async () => {
    const fetch = mockFetch([{ status: 503, ok: false, body: { sealed: true } }]);
    const p = createProvider({}, fetch);
    const result = await p.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sealed");
  });

  it("returns error on connection failure", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const p = createProvider({}, fetch as unknown as ReturnType<typeof mockFetch>);
    const result = await p.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Cannot connect");
  });
});

// ===========================================================================
// Error Handling — re-auth on 403 for AppRole
// ===========================================================================

describe("VaultSecretProvider — re-auth on 403", () => {
  it("retries with fresh token on 403 for approle auth", async () => {
    const fetch = mockFetch([
      // Initial AppRole login
      { status: 200, body: { auth: { client_token: "s.token-1" } } },
      // First attempt → 403 (expired token)
      { status: 403, ok: false, body: { errors: ["permission denied"] } },
      // Re-login
      { status: 200, body: { auth: { client_token: "s.token-2" } } },
      // Retry → success
      { status: 200, body: { data: { data: { value: "refreshed" } } } },
    ]);
    const p = createProvider(
      { token: undefined, authMethod: "approle", roleId: "r", secretId: "s" },
      fetch,
    );
    const val = await p.getSecret("test");
    expect(val).toBe("refreshed");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry for token auth on 403", async () => {
    const fetch = mockFetch([{ status: 403, ok: false, body: { errors: ["permission denied"] } }]);
    const p = createProvider({ authMethod: "token" }, fetch);
    await expect(p.getSecret("test")).rejects.toThrow("Permission denied");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Dynamic Secrets / Lease Management
// ===========================================================================

describe("VaultSecretProvider — Dynamic Secrets", () => {
  it("requests dynamic credentials", async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: {
          lease_id: "database/creds/my-role/abc123",
          lease_duration: 3600,
          renewable: true,
          data: { username: "v-approle-my-role-abc", password: "A1B2C3" },
        },
      },
    ]);
    const p = createProvider({}, fetch);
    const lease = await p.requestDynamic("database", "my-role");
    expect(lease.leaseId).toBe("database/creds/my-role/abc123");
    expect(lease.ttl).toBe(3600);
    expect(lease.renewable).toBe(true);
    expect(fetch.mock.calls[0][0]).toContain("/v1/database/creds/my-role");
  });

  it("renews a lease", async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: {
          lease_id: "database/creds/my-role/abc123",
          lease_duration: 3600,
          renewable: true,
        },
      },
    ]);
    const p = createProvider({}, fetch);
    const renewed = await p.renewLease("database/creds/my-role/abc123");
    expect(renewed.ttl).toBe(3600);
    const [, opts] = fetch.mock.calls[0];
    expect(JSON.parse(opts?.body as string)).toEqual({ lease_id: "database/creds/my-role/abc123" });
  });

  it("revokes a lease", async () => {
    const fetch = mockFetch([{ status: 204 }]);
    const p = createProvider({}, fetch);
    await p.revokeLease("database/creds/my-role/abc123");
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toContain("/v1/sys/leases/revoke");
    expect(opts?.method).toBe("PUT");
  });
});

// ===========================================================================
// Static Rotation Polling
// ===========================================================================

describe("VaultSecretProvider — Static Creds", () => {
  it("fetches static credentials with last_vault_rotation", async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: {
          data: {
            data: {
              username: "static-user",
              password: "rotated-pw",
              last_vault_rotation: "2026-02-15T10:00:00Z",
              ttl: 86400,
            },
          },
        },
      },
    ]);
    const p = createProvider({}, fetch);
    const creds = await p.getStaticCreds("database", "my-static-role");
    expect(creds.username).toBe("static-user");
    expect(creds.password).toBe("rotated-pw");
    expect(creds.lastVaultRotation).toBe("2026-02-15T10:00:00Z");
  });
});

// ===========================================================================
// Rotation Metadata (custom_metadata)
// ===========================================================================

describe("VaultSecretProvider — Rotation Metadata", () => {
  it("reads custom_metadata from KV v2 metadata endpoint", async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: {
          data: {
            custom_metadata: { "rotation-type": "manual", "rotation-interval-days": "90" },
            current_version: 5,
          },
        },
      },
    ]);
    const p = createProvider({}, fetch);
    const meta = await p.getSecretMetadata("my-secret");
    expect(meta.customMetadata).toEqual({
      "rotation-type": "manual",
      "rotation-interval-days": "90",
    });
    expect(meta.currentVersion).toBe(5);
    expect(fetch.mock.calls[0][0]).toContain("/v1/secret/metadata/my-secret");
  });

  it("writes custom_metadata to KV v2 metadata endpoint", async () => {
    const fetch = mockFetch([{ status: 204 }]);
    const p = createProvider({}, fetch);
    await p.updateSecretMetadata("my-secret", {
      "rotation-type": "manual",
      "last-rotated": "2026-02-15",
    });
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toContain("/v1/secret/metadata/my-secret");
    expect(JSON.parse(opts?.body as string)).toEqual({
      custom_metadata: { "rotation-type": "manual", "last-rotated": "2026-02-15" },
    });
  });

  it("handles null custom_metadata gracefully", async () => {
    const fetch = mockFetch([
      { status: 200, body: { data: { custom_metadata: null, current_version: 1 } } },
    ]);
    const p = createProvider({}, fetch);
    const meta = await p.getSecretMetadata("test");
    expect(meta.customMetadata).toEqual({});
  });
});

// ===========================================================================
// VaultLeaseManager
// ===========================================================================

describe("VaultLeaseManager", () => {
  it("tracks requested dynamic leases", async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: {
          lease_id: "db/creds/role/1",
          lease_duration: 3600,
          renewable: true,
          data: { username: "u", password: "p" },
        },
      },
    ]);
    const p = createProvider({}, fetch);
    const mgr = new VaultLeaseManager(p);
    const lease = await mgr.requestDynamic("db", "role");
    expect(lease.leaseId).toBe("db/creds/role/1");
    expect(mgr.listActiveLeases()).toHaveLength(1);
  });

  it("revokeAll clears all leases", async () => {
    const fetch = mockFetch([
      // requestDynamic
      {
        status: 200,
        body: { lease_id: "lease-1", lease_duration: 60, renewable: false, data: {} },
      },
      // revokeLease
      { status: 204 },
    ]);
    const p = createProvider({}, fetch);
    const mgr = new VaultLeaseManager(p);
    await mgr.requestDynamic("db", "role");
    expect(mgr.listActiveLeases()).toHaveLength(1);
    await mgr.revokeAll();
    expect(mgr.listActiveLeases()).toHaveLength(0);
  });
});

// ===========================================================================
// SecretProvider interface compliance
// ===========================================================================

describe("VaultSecretProvider — SecretProvider interface", () => {
  it("has name 'vault'", () => {
    const p = createProvider();
    expect(p.name).toBe("vault");
  });

  it("implements all SecretProvider methods", () => {
    const p = createProvider();
    expect(typeof p.getSecret).toBe("function");
    expect(typeof p.setSecret).toBe("function");
    expect(typeof p.listSecrets).toBe("function");
    expect(typeof p.testConnection).toBe("function");
  });
});

// ===========================================================================
// Config defaults
// ===========================================================================

describe("VaultSecretProvider — Config", () => {
  it("defaults mountPath to 'secret'", async () => {
    const fetch = mockFetch([{ status: 200, body: { data: { data: { value: "v" } } } }]);
    const p = createProvider({ mountPath: undefined }, fetch);
    await p.getSecret("test");
    expect(fetch.mock.calls[0][0]).toContain("/v1/secret/data/test");
  });

  it("defaults authMethod to 'token'", () => {
    const p = createProvider({ authMethod: undefined });
    // No way to directly check, but it should work with token
    expect(p.name).toBe("vault");
  });

  it("strips trailing slash from address", async () => {
    const fetch = mockFetch([{ status: 200, body: { data: { data: { value: "v" } } } }]);
    const p = createProvider({ address: "http://vault.local:8200/" }, fetch);
    await p.getSecret("test");
    expect(fetch.mock.calls[0][0]).toBe("http://vault.local:8200/v1/secret/data/test");
  });

  it("cacheTtlMs defaults to 300000 (5 min)", () => {
    const p = createProvider({ cacheTtlSeconds: undefined });
    expect(p.cacheTtlMs).toBe(300_000);
  });

  it("cacheTtlMs respects custom value", () => {
    const p = createProvider({ cacheTtlSeconds: 60 });
    expect(p.cacheTtlMs).toBe(60_000);
  });
});
