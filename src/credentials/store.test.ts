import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStore, CredentialFirewallError, type SecretResolver } from "./store.js";
import type { CredentialStoreConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResolver(secrets: Record<string, string>): SecretResolver {
  return vi.fn(async (source: string) => {
    if (source in secrets) {
      return secrets[source];
    }
    throw new Error(`Secret not found: ${source}`);
  });
}

const GMAIL_CRED: CredentialStoreConfig = {
  credentials: [
    {
      slot: "gmail",
      source: "${bw:gmail-account/password}",
      pinnedDomains: ["accounts.google.com", "mail.google.com"],
      allowedSelectors: ["#password", "input[type=password]"],
      label: "Gmail login",
    },
  ],
};

const GITHUB_CRED: CredentialStoreConfig = {
  credentials: [
    {
      slot: "github",
      source: "${keyring:github-pass}",
      pinnedDomains: ["github.com", "*.github.com"],
      label: "GitHub login",
    },
  ],
};

const EXPIRED_CRED: CredentialStoreConfig = {
  credentials: [
    {
      slot: "expired",
      source: "old-password",
      pinnedDomains: ["example.com"],
      expiresAt: "2020-01-01T00:00:00Z",
    },
  ],
};

const MULTI_CRED: CredentialStoreConfig = {
  credentials: [
    {
      slot: "gmail",
      source: "${bw:gmail-account/password}",
      pinnedDomains: ["accounts.google.com"],
      allowedSelectors: ["#password"],
    },
    {
      slot: "github",
      source: "${keyring:github-pass}",
      pinnedDomains: ["github.com"],
    },
    {
      slot: "aws",
      source: "${op:Private/AWS/password}",
      pinnedDomains: ["signin.aws.amazon.com"],
    },
  ],
};

const DEFAULT_SECRETS: Record<string, string> = {
  "${bw:gmail-account/password}": "gmail-secret-pass-123",
  "${keyring:github-pass}": "gh-token-456",
  "${op:Private/AWS/password}": "aws-secret-789",
  "plain-text-password": "plain-text-password",
  "${gcp:my-secret}": "gcp-value",
  "${aws:my-secret}": "aws-value",
  "${env:MY_VAR}": "env-value",
  "${age:secrets.age#db.password}": "age-value",
  "${vault:secret/data/myapp}": "vault-value",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CredentialStore", () => {
  // =========================================================================
  // resolve — happy path
  // =========================================================================

  describe("resolve — happy path", () => {
    it("resolves credential when domain and selector match", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "gmail",
        currentUrl: "https://accounts.google.com/signin",
        selector: "#password",
      });
      expect(value).toBe("gmail-secret-pass-123");
    });

    it("resolves with wildcard domain", async () => {
      const store = new CredentialStore(GITHUB_CRED, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "github",
        currentUrl: "https://gist.github.com/login",
        selector: "#password",
      });
      expect(value).toBe("gh-token-456");
    });

    it("resolves with no selector restriction", async () => {
      const store = new CredentialStore(GITHUB_CRED, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "github",
        currentUrl: "https://github.com/login",
        selector: ".any-selector-works",
      });
      expect(value).toBe("gh-token-456");
    });

    it("resolves plain text source as fallback", async () => {
      const config: CredentialStoreConfig = {
        credentials: [
          { slot: "plain", source: "plain-text-password", pinnedDomains: ["example.com"] },
        ],
      };
      const store = new CredentialStore(config, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "plain",
        currentUrl: "https://example.com/login",
        selector: "#pw",
      });
      expect(value).toBe("plain-text-password");
    });
  });

  // =========================================================================
  // resolve — provider compatibility
  // =========================================================================

  describe("resolve — provider compatibility", () => {
    it("resolves via Bitwarden provider (${bw:...})", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "gmail",
        currentUrl: "https://accounts.google.com/signin",
        selector: "#password",
      });
      expect(value).toBe("gmail-secret-pass-123");
    });

    it("resolves via OS keyring provider (${keyring:...})", async () => {
      const store = new CredentialStore(GITHUB_CRED, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "github",
        currentUrl: "https://github.com/login",
        selector: "#pw",
      });
      expect(value).toBe("gh-token-456");
    });

    it("resolves via 1Password provider (${op:...})", async () => {
      const config: CredentialStoreConfig = {
        credentials: [
          {
            slot: "aws",
            source: "${op:Private/AWS/password}",
            pinnedDomains: ["signin.aws.amazon.com"],
          },
        ],
      };
      const store = new CredentialStore(config, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "aws",
        currentUrl: "https://signin.aws.amazon.com/",
        selector: "#password",
      });
      expect(value).toBe("aws-secret-789");
    });

    it("resolves via GCP provider (${gcp:...})", async () => {
      const config: CredentialStoreConfig = {
        credentials: [
          { slot: "db", source: "${gcp:my-secret}", pinnedDomains: ["console.cloud.google.com"] },
        ],
      };
      const store = new CredentialStore(config, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "db",
        currentUrl: "https://console.cloud.google.com/sql",
        selector: "#pw",
      });
      expect(value).toBe("gcp-value");
    });

    it("resolves via AWS provider (${aws:...})", async () => {
      const config: CredentialStoreConfig = {
        credentials: [
          { slot: "rds", source: "${aws:my-secret}", pinnedDomains: ["console.aws.amazon.com"] },
        ],
      };
      const store = new CredentialStore(config, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "rds",
        currentUrl: "https://console.aws.amazon.com/rds",
        selector: "#pw",
      });
      expect(value).toBe("aws-value");
    });

    it("resolves via env provider (${env:...})", async () => {
      const config: CredentialStoreConfig = {
        credentials: [
          { slot: "staging", source: "${env:MY_VAR}", pinnedDomains: ["staging.app.com"] },
        ],
      };
      const store = new CredentialStore(config, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "staging",
        currentUrl: "https://staging.app.com/login",
        selector: "#pw",
      });
      expect(value).toBe("env-value");
    });

    it("resolves via age/sops provider (${age:...})", async () => {
      const config: CredentialStoreConfig = {
        credentials: [
          {
            slot: "db",
            source: "${age:secrets.age#db.password}",
            pinnedDomains: ["db.internal.com"],
          },
        ],
      };
      const store = new CredentialStore(config, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "db",
        currentUrl: "https://db.internal.com/admin",
        selector: "#pw",
      });
      expect(value).toBe("age-value");
    });

    it("resolves via HashiCorp Vault provider (${vault:...})", async () => {
      const config: CredentialStoreConfig = {
        credentials: [
          {
            slot: "app",
            source: "${vault:secret/data/myapp}",
            pinnedDomains: ["app.internal.com"],
          },
        ],
      };
      const store = new CredentialStore(config, mockResolver(DEFAULT_SECRETS));
      const value = await store.resolve({
        slot: "app",
        currentUrl: "https://app.internal.com",
        selector: "#pw",
      });
      expect(value).toBe("vault-value");
    });

    it("resolves via Azure Key Vault provider (${azure:...})", async () => {
      const secrets = { ...DEFAULT_SECRETS, "${azure:myvault/db-password}": "azure-value" };
      const config: CredentialStoreConfig = {
        credentials: [
          {
            slot: "azdb",
            source: "${azure:myvault/db-password}",
            pinnedDomains: ["portal.azure.com"],
          },
        ],
      };
      const store = new CredentialStore(config, mockResolver(secrets));
      const value = await store.resolve({
        slot: "azdb",
        currentUrl: "https://portal.azure.com/resource",
        selector: "#pw",
      });
      expect(value).toBe("azure-value");
    });
  });

  // =========================================================================
  // resolve — multi-field credentials
  // =========================================================================

  describe("resolve — multi-field credentials", () => {
    const MULTI_FIELD_CONFIG: CredentialStoreConfig = {
      credentials: [
        {
          slot: "work-email",
          source: "${bw:work-email/password}",
          usernameSource: "${bw:work-email/username}",
          totpSource: "${bw:work-email/totp}",
          pinnedDomains: ["login.microsoftonline.com"],
        },
      ],
    };
    const multiSecrets = {
      "${bw:work-email/password}": "secret-pass",
      "${bw:work-email/username}": "user@work.com",
      "${bw:work-email/totp}": "123456",
    };

    it("resolves password field by default", async () => {
      const store = new CredentialStore(MULTI_FIELD_CONFIG, mockResolver(multiSecrets));
      const value = await store.resolve({
        slot: "work-email",
        currentUrl: "https://login.microsoftonline.com/",
        selector: "#password",
      });
      expect(value).toBe("secret-pass");
    });

    it("resolves username field when field='username'", async () => {
      const store = new CredentialStore(MULTI_FIELD_CONFIG, mockResolver(multiSecrets));
      const value = await store.resolve({
        slot: "work-email",
        currentUrl: "https://login.microsoftonline.com/",
        selector: "#email",
        field: "username",
      });
      expect(value).toBe("user@work.com");
    });

    it("resolves totp field when field='totp'", async () => {
      const store = new CredentialStore(MULTI_FIELD_CONFIG, mockResolver(multiSecrets));
      const value = await store.resolve({
        slot: "work-email",
        currentUrl: "https://login.microsoftonline.com/",
        selector: "#mfa-code",
        field: "totp",
      });
      expect(value).toBe("123456");
    });

    it("throws RESOLVE_FAILED when username source not configured", async () => {
      const noUsername: CredentialStoreConfig = {
        credentials: [{ slot: "pw-only", source: "pw", pinnedDomains: ["example.com"] }],
      };
      const store = new CredentialStore(noUsername, mockResolver({ pw: "val" }));
      try {
        await store.resolve({
          slot: "pw-only",
          currentUrl: "https://example.com",
          selector: "#user",
          field: "username",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as CredentialFirewallError).code).toBe("RESOLVE_FAILED");
        expect((err as CredentialFirewallError).message).toContain("no username source");
      }
    });

    it("throws RESOLVE_FAILED when totp source not configured", async () => {
      const noTotp: CredentialStoreConfig = {
        credentials: [{ slot: "no-totp", source: "pw", pinnedDomains: ["example.com"] }],
      };
      const store = new CredentialStore(noTotp, mockResolver({ pw: "val" }));
      try {
        await store.resolve({
          slot: "no-totp",
          currentUrl: "https://example.com",
          selector: "#mfa",
          field: "totp",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as CredentialFirewallError).code).toBe("RESOLVE_FAILED");
        expect((err as CredentialFirewallError).message).toContain("no totp source");
      }
    });
  });

  // =========================================================================
  // resolve — security invariants
  // =========================================================================

  describe("resolve — security invariants", () => {
    it("credential value never appears in error.message on domain block", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({ slot: "gmail", currentUrl: "https://evil.com", selector: "#pw" });
        expect.unreachable("should have thrown");
      } catch (err) {
        const msg = (err as CredentialFirewallError).message;
        expect(msg).not.toContain("gmail-secret-pass-123");
      }
    });

    it("credential value never appears in JSON.stringify(error) on domain block", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({ slot: "gmail", currentUrl: "https://evil.com", selector: "#pw" });
        expect.unreachable("should have thrown");
      } catch (err) {
        const serialized = JSON.stringify(err);
        expect(serialized).not.toContain("gmail-secret-pass-123");
      }
    });

    it("credential value never appears in JSON.stringify(error) on selector block", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://accounts.google.com",
          selector: "#wrong",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        const serialized = JSON.stringify(err);
        expect(serialized).not.toContain("gmail-secret-pass-123");
      }
    });

    it("multiple slots on same domain resolve independently", async () => {
      const config: CredentialStoreConfig = {
        credentials: [
          { slot: "user-a", source: "pass-a", pinnedDomains: ["shared.example.com"] },
          { slot: "user-b", source: "pass-b", pinnedDomains: ["shared.example.com"] },
        ],
      };
      const store = new CredentialStore(
        config,
        mockResolver({ "pass-a": "a-val", "pass-b": "b-val" }),
      );
      const a = await store.resolve({
        slot: "user-a",
        currentUrl: "https://shared.example.com",
        selector: "#pw",
      });
      const b = await store.resolve({
        slot: "user-b",
        currentUrl: "https://shared.example.com",
        selector: "#pw",
      });
      expect(a).toBe("a-val");
      expect(b).toBe("b-val");
    });
  });

  // =========================================================================
  // resolve — domain pinning
  // =========================================================================

  describe("resolve — domain pinning", () => {
    it("blocks credential on wrong domain", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://evil.com/phishing",
          selector: "#password",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CredentialFirewallError);
        expect((err as CredentialFirewallError).code).toBe("DOMAIN_BLOCKED");
        expect((err as CredentialFirewallError).detail?.hostname).toBe("evil.com");
      }
    });

    it("blocks credential on subdomain when only exact domain pinned", async () => {
      const config: CredentialStoreConfig = {
        credentials: [{ slot: "exact", source: "pw", pinnedDomains: ["login.example.com"] }],
      };
      const store = new CredentialStore(config, mockResolver({ pw: "val" }));
      try {
        await store.resolve({
          slot: "exact",
          currentUrl: "https://sub.login.example.com",
          selector: "#pw",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as CredentialFirewallError).code).toBe("DOMAIN_BLOCKED");
      }
    });

    it("error includes hostname and pinned domains", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://attacker.com",
          selector: "#password",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        const detail = (err as CredentialFirewallError).detail;
        expect(detail?.hostname).toBe("attacker.com");
        expect(detail?.pinnedDomains).toEqual(["accounts.google.com", "mail.google.com"]);
      }
    });

    it("does not call resolver when domain is blocked", async () => {
      const resolver = mockResolver(DEFAULT_SECRETS);
      const store = new CredentialStore(GMAIL_CRED, resolver);
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://evil.com",
          selector: "#password",
        });
      } catch {
        // expected
      }
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // resolve — selector check
  // =========================================================================

  describe("resolve — selector check", () => {
    it("blocks credential on wrong selector", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://accounts.google.com/signin",
          selector: "#visible-text-field",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as CredentialFirewallError).code).toBe("SELECTOR_BLOCKED");
      }
    });

    it("error includes selector and allowed list", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://accounts.google.com/signin",
          selector: "#wrong",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        const detail = (err as CredentialFirewallError).detail;
        expect(detail?.selector).toBe("#wrong");
        expect(detail?.allowedSelectors).toEqual(["#password", "input[type=password]"]);
      }
    });
  });

  // =========================================================================
  // resolve — slot not found
  // =========================================================================

  describe("resolve — slot not found", () => {
    it("throws SLOT_NOT_FOUND with available slots", async () => {
      const store = new CredentialStore(MULTI_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({ slot: "nonexistent", currentUrl: "https://x.com", selector: "#pw" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as CredentialFirewallError).code).toBe("SLOT_NOT_FOUND");
        expect((err as CredentialFirewallError).detail?.availableSlots).toEqual([
          "gmail",
          "github",
          "aws",
        ]);
      }
    });
  });

  // =========================================================================
  // resolve — expiry
  // =========================================================================

  describe("resolve — expiry", () => {
    it("blocks expired credential", async () => {
      const store = new CredentialStore(EXPIRED_CRED, mockResolver({ "old-password": "val" }));
      try {
        await store.resolve({
          slot: "expired",
          currentUrl: "https://example.com",
          selector: "#pw",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as CredentialFirewallError).code).toBe("EXPIRED");
      }
    });

    it("allows non-expired credential", async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const config: CredentialStoreConfig = {
        credentials: [
          { slot: "valid", source: "pw", pinnedDomains: ["example.com"], expiresAt: future },
        ],
      };
      const store = new CredentialStore(config, mockResolver({ pw: "val" }));
      const value = await store.resolve({
        slot: "valid",
        currentUrl: "https://example.com",
        selector: "#pw",
      });
      expect(value).toBe("val");
    });
  });

  // =========================================================================
  // resolve — provider failure
  // =========================================================================

  describe("resolve — provider failure", () => {
    it("throws RESOLVE_FAILED when provider errors", async () => {
      const failResolver: SecretResolver = async () => {
        throw new Error("Vault is locked");
      };
      const store = new CredentialStore(GMAIL_CRED, failResolver);
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://accounts.google.com/signin",
          selector: "#password",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as CredentialFirewallError).code).toBe("RESOLVE_FAILED");
        expect((err as CredentialFirewallError).message).toContain("Vault is locked");
      }
    });

    it("does not expose provider source in error detail", async () => {
      const failResolver: SecretResolver = async () => {
        throw new Error("Auth failed");
      };
      const store = new CredentialStore(GMAIL_CRED, failResolver);
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://accounts.google.com/signin",
          selector: "#password",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        const detail = (err as CredentialFirewallError).detail;
        expect(detail).toBeDefined();
        expect(detail?.source).toBeUndefined();
      }
    });
  });

  // =========================================================================
  // audit log
  // =========================================================================

  describe("audit log", () => {
    it("records successful use", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      await store.resolve({
        slot: "gmail",
        currentUrl: "https://accounts.google.com/signin",
        selector: "#password",
      });
      const log = store.getAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0].slot).toBe("gmail");
      expect(log[0].allowed).toBe(true);
      expect(log[0].timestamp).toBeTruthy();
    });

    it("records blocked use with reason", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      try {
        await store.resolve({
          slot: "gmail",
          currentUrl: "https://evil.com",
          selector: "#password",
        });
      } catch {
        // expected
      }
      const log = store.getAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0].allowed).toBe(false);
      expect(log[0].reason).toContain("domain");
    });

    it("never contains credential values", async () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      await store.resolve({
        slot: "gmail",
        currentUrl: "https://accounts.google.com/signin",
        selector: "#password",
      });
      const logJson = JSON.stringify(store.getAuditLog());
      expect(logJson).not.toContain("gmail-secret-pass-123");
    });

    it("caps audit log at max size", async () => {
      const config: CredentialStoreConfig = {
        credentials: [{ slot: "x", source: "pw", pinnedDomains: ["example.com"] }],
      };
      const store = new CredentialStore(config, mockResolver({ pw: "v" }));
      for (let i = 0; i < 1100; i++) {
        await store.resolve({ slot: "x", currentUrl: "https://example.com", selector: "#pw" });
      }
      expect(store.getAuditLog().length).toBeLessThanOrEqual(1000);
    });
  });

  // =========================================================================
  // listSlots / getEntry
  // =========================================================================

  describe("listSlots / getEntry", () => {
    it("returns all configured slot names", () => {
      const store = new CredentialStore(MULTI_CRED, mockResolver(DEFAULT_SECRETS));
      expect(store.listSlots()).toEqual(["gmail", "github", "aws"]);
    });

    it("returns entry for existing slot", () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      const entry = store.getEntry("gmail");
      expect(entry?.slot).toBe("gmail");
      expect(entry?.pinnedDomains).toEqual(["accounts.google.com", "mail.google.com"]);
    });

    it("returns undefined for unknown slot", () => {
      const store = new CredentialStore(GMAIL_CRED, mockResolver(DEFAULT_SECRETS));
      expect(store.getEntry("nonexistent")).toBeUndefined();
    });
  });

  // =========================================================================
  // constructor validation
  // =========================================================================

  describe("constructor", () => {
    it("skips entries with empty pinnedDomains", () => {
      const config: CredentialStoreConfig = {
        credentials: [{ slot: "bad", source: "pw", pinnedDomains: [] }],
      };
      const store = new CredentialStore(config, mockResolver({}));
      expect(store.listSlots()).toEqual([]);
    });

    it("skips entries with no source", () => {
      const config: CredentialStoreConfig = {
        credentials: [{ slot: "bad", source: "", pinnedDomains: ["example.com"] }],
      };
      const store = new CredentialStore(config, mockResolver({}));
      expect(store.listSlots()).toEqual([]);
    });

    it("handles empty credentials config", () => {
      const store = new CredentialStore({}, mockResolver({}));
      expect(store.listSlots()).toEqual([]);
    });

    it("handles undefined credentials", () => {
      const store = new CredentialStore({ credentials: undefined }, mockResolver({}));
      expect(store.listSlots()).toEqual([]);
    });

    it("skips entries with empty slot name", () => {
      const config: CredentialStoreConfig = {
        credentials: [{ slot: "", source: "pw", pinnedDomains: ["example.com"] }],
      };
      const store = new CredentialStore(config, mockResolver({}));
      expect(store.listSlots()).toEqual([]);
    });
  });
});
