/**
 * Tests for AWS Secrets Manager provider.
 *
 * All tests use mocked SDK — no real AWS credentials needed.
 */

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { clearSecretCache, type SecretProvider } from "./secret-resolution.js";

// ---------------------------------------------------------------------------
// Mock AWS SDK
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

function makeCmd(type: string) {
  return class {
    _type = type;
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  };
}

vi.mock("@aws-sdk/client-secrets-manager", () => {
  class MockSecretsManagerClient {
    send = mockSend;
  }
  return {
    SecretsManagerClient: MockSecretsManagerClient,
    GetSecretValueCommand: makeCmd("GetSecretValue"),
    PutSecretValueCommand: makeCmd("PutSecretValue"),
    CreateSecretCommand: makeCmd("CreateSecret"),
    ListSecretsCommand: makeCmd("ListSecrets"),
    DescribeSecretCommand: makeCmd("DescribeSecret"),
    TagResourceCommand: makeCmd("TagResource"),
  };
});

// Import after mocks
import { AwsSecretProvider, clearAwsSecretCache } from "./aws-secret-provider.js";

beforeEach(() => {
  clearSecretCache();
  clearAwsSecretCache();
  mockSend.mockReset();
});

// ===========================================================================
// Construction
// ===========================================================================

describe("AwsSecretProvider — construction", () => {
  it("sets name to 'aws'", () => {
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    expect(provider.name).toBe("aws");
  });

  it("accepts region config", () => {
    const provider = new AwsSecretProvider({ region: "eu-west-1" });
    expect(provider).toBeDefined();
  });

  it("accepts optional config fields", () => {
    const provider = new AwsSecretProvider({
      region: "us-east-1",
      profile: "openclaw",
      roleArn: "arn:aws:iam::123456789012:role/openclaw",
      externalId: "ext-123",
      cacheTtlSeconds: 600,
    });
    expect(provider).toBeDefined();
  });
});

// ===========================================================================
// getSecret
// ===========================================================================

describe("AwsSecretProvider — getSecret", () => {
  it("fetches a secret by name (string value)", async () => {
    mockSend.mockResolvedValueOnce({ SecretString: "my-secret-value" });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const value = await provider.getSecret("my-secret");
    expect(value).toBe("my-secret-value");
  });

  it("fetches a secret by name (binary value)", async () => {
    mockSend.mockResolvedValueOnce({
      SecretBinary: Buffer.from("binary-secret", "utf-8"),
    });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const value = await provider.getSecret("my-binary-secret");
    expect(value).toBe("binary-secret");
  });

  it("passes VersionId when version is provided", async () => {
    mockSend.mockResolvedValueOnce({ SecretString: "versioned-value" });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const value = await provider.getSecret("my-secret", "abc123");
    expect(value).toBe("versioned-value");
    // Verify the command was constructed with version params
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input).toEqual({
      SecretId: "my-secret",
      VersionId: "abc123",
      VersionStage: "abc123",
    });
  });

  it("throws on ResourceNotFoundException", async () => {
    const err = new Error("Secret not found");
    (err as any).name = "ResourceNotFoundException";
    mockSend.mockRejectedValueOnce(err);
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    await expect(provider.getSecret("missing")).rejects.toThrow(/not found/i);
  });

  it("throws on AccessDeniedException", async () => {
    const err = new Error("Access denied");
    (err as any).name = "AccessDeniedException";
    mockSend.mockRejectedValueOnce(err);
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    await expect(provider.getSecret("forbidden")).rejects.toThrow(/permission denied/i);
  });

  it("throws on DecryptionFailureException", async () => {
    const err = new Error("Cannot decrypt");
    (err as any).name = "DecryptionFailureException";
    mockSend.mockRejectedValueOnce(err);
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    await expect(provider.getSecret("encrypted")).rejects.toThrow(/decrypt/i);
  });

  it("throws when secret has no value", async () => {
    mockSend.mockResolvedValueOnce({});
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    await expect(provider.getSecret("empty")).rejects.toThrow(/no payload/i);
  });

  it("caches secret values", async () => {
    mockSend.mockResolvedValueOnce({ SecretString: "cached-value" });
    const provider = new AwsSecretProvider({ region: "us-east-1", cacheTtlSeconds: 300 });
    const v1 = await provider.getSecret("cached-secret");
    const v2 = await provider.getSecret("cached-secret");
    expect(v1).toBe("cached-value");
    expect(v2).toBe("cached-value");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("returns stale cache on network error", async () => {
    // First call succeeds
    mockSend.mockResolvedValueOnce({ SecretString: "stale-value" });
    const provider = new AwsSecretProvider({ region: "us-east-1", cacheTtlSeconds: 0 });
    await provider.getSecret("flaky-secret");

    // TTL=0 means expired immediately; next call fails
    mockSend.mockRejectedValueOnce(new Error("Network timeout"));
    const value = await provider.getSecret("flaky-secret");
    expect(value).toBe("stale-value");
  });
});

// ===========================================================================
// setSecret
// ===========================================================================

describe("AwsSecretProvider — setSecret", () => {
  it("creates and stores a secret", async () => {
    mockSend.mockResolvedValueOnce({}); // PutSecretValue
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    await provider.setSecret("new-secret", "new-value");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("falls back to create + put if ResourceNotFoundException on put", async () => {
    const err = new Error("not found");
    (err as any).name = "ResourceNotFoundException";
    mockSend
      .mockRejectedValueOnce(err) // PutSecretValue fails — doesn't exist
      .mockResolvedValueOnce({}) // CreateSecret
      .mockResolvedValueOnce({}); // PutSecretValue retry
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    await provider.setSecret("brand-new", "value");
    expect(mockSend).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// listSecrets
// ===========================================================================

describe("AwsSecretProvider — listSecrets", () => {
  it("lists secrets", async () => {
    mockSend.mockResolvedValueOnce({
      SecretList: [{ Name: "secret-a" }, { Name: "secret-b" }],
    });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const names = await provider.listSecrets();
    expect(names).toEqual(["secret-a", "secret-b"]);
  });

  it("handles pagination", async () => {
    mockSend
      .mockResolvedValueOnce({
        SecretList: [{ Name: "a" }],
        NextToken: "token1",
      })
      .mockResolvedValueOnce({
        SecretList: [{ Name: "b" }],
      });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const names = await provider.listSecrets();
    expect(names).toEqual(["a", "b"]);
  });

  it("returns empty array when no secrets", async () => {
    mockSend.mockResolvedValueOnce({ SecretList: [] });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const names = await provider.listSecrets();
    expect(names).toEqual([]);
  });
});

// ===========================================================================
// testConnection
// ===========================================================================

describe("AwsSecretProvider — testConnection", () => {
  it("returns ok on success", async () => {
    mockSend.mockResolvedValueOnce({ SecretList: [] });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const result = await provider.testConnection();
    expect(result).toEqual({ ok: true });
  });

  it("returns error on failure", async () => {
    mockSend.mockRejectedValueOnce(new Error("boom"));
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });
});

// ===========================================================================
// Integration with secret-resolution
// ===========================================================================

describe("AwsSecretProvider — integration with resolveConfigSecrets", () => {
  it("resolves ${aws:name} references", async () => {
    mockSend.mockResolvedValue({ SecretString: "resolved-aws-value" });
    const { resolveConfigSecrets } = await import("./secret-resolution.js");
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const providers = new Map<string, SecretProvider>([["aws", provider]]);
    const config = { key: "${aws:my-secret}" };
    const result = await resolveConfigSecrets(config, undefined, providers);
    expect(result).toEqual({ key: "resolved-aws-value" });
  });

  it("resolves versioned ${aws:name#version} references", async () => {
    mockSend.mockResolvedValue({ SecretString: "v2-value" });
    const { resolveConfigSecrets } = await import("./secret-resolution.js");
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const providers = new Map<string, SecretProvider>([["aws", provider]]);
    const config = { key: "${aws:my-secret#v2}" };
    const result = await resolveConfigSecrets(config, undefined, providers);
    expect(result).toEqual({ key: "v2-value" });
  });
});

// ===========================================================================
// Rotation support
// ===========================================================================

describe("AwsSecretProvider — rotation", () => {
  it("describeSecret returns rotation metadata", async () => {
    mockSend.mockResolvedValueOnce({
      Name: "my-secret",
      LastRotatedDate: new Date("2026-01-15T00:00:00Z"),
      RotationEnabled: true,
      RotationRules: { AutomaticallyAfterDays: 30 },
      Tags: [
        { Key: "rotation-type", Value: "auto" },
        { Key: "rotation-interval-days", Value: "30" },
      ],
    });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const meta = await provider.describeSecret("my-secret");
    expect(meta.lastRotatedDate).toEqual(new Date("2026-01-15T00:00:00Z"));
    expect(meta.rotationEnabled).toBe(true);
    expect(meta.tags).toBeDefined();
  });

  it("getTags returns secret tags", async () => {
    mockSend.mockResolvedValueOnce({
      Tags: [
        { Key: "rotation-type", Value: "manual" },
        { Key: "rotation-interval-days", Value: "90" },
      ],
    });
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    const tags = await provider.getTags("my-secret");
    expect(tags).toEqual({
      "rotation-type": "manual",
      "rotation-interval-days": "90",
    });
  });

  it("setTags updates secret tags", async () => {
    mockSend.mockResolvedValueOnce({}); // TagResource
    const provider = new AwsSecretProvider({ region: "us-east-1" });
    await provider.setTags("my-secret", { "rotation-type": "auto" });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
