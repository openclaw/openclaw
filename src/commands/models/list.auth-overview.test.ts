import { describe, expect, it } from "vitest";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

describe("resolveProviderAuthOverview", () => {
  it("does not throw when token profile only has tokenRef", () => {
    const overview = resolveProviderAuthOverview({
      provider: "github-copilot",
      cfg: {},
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
        },
      } as never,
      modelsPath: "/tmp/models.json",
    });

    expect(overview.profiles.labels[0]).toContain("token:ref(env:GITHUB_TOKEN)");
  });

  it("detects AWS SDK auth when provider is alias bedrock", () => {
    const original = process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token-value";
    try {
      const overview = resolveProviderAuthOverview({
        provider: "bedrock",
        cfg: {},
        store: { version: 1, profiles: {} } as never,
        modelsPath: "/tmp/models.json",
      });
      expect(overview.effective.kind).toBe("env");
      expect(overview.effective.detail).toContain("aws-sdk");
    } finally {
      if (original === undefined) {
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      } else {
        process.env.AWS_BEARER_TOKEN_BEDROCK = original;
      }
    }
  });

  it("shows full IAM key pair in env source label", () => {
    const origBearer = process.env.AWS_BEARER_TOKEN_BEDROCK;
    const origAccess = process.env.AWS_ACCESS_KEY_ID;
    const origSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    try {
      const overview = resolveProviderAuthOverview({
        provider: "amazon-bedrock",
        cfg: {},
        store: { version: 1, profiles: {} } as never,
        modelsPath: "/tmp/models.json",
      });
      expect(overview.effective.kind).toBe("env");
      expect(overview.effective.detail).toContain("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY");
      expect(overview.env?.source).toContain("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY");
    } finally {
      if (origBearer === undefined) {
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      } else {
        process.env.AWS_BEARER_TOKEN_BEDROCK = origBearer;
      }
      if (origAccess === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = origAccess;
      }
      if (origSecret === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = origSecret;
      }
    }
  });
});

describe("resolveProviderAuthOverview — Bedrock AWS SDK auth", () => {
  it("detects AWS_BEARER_TOKEN_BEDROCK as effective auth for amazon-bedrock", () => {
    const original = process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token-value";
    try {
      const overview = resolveProviderAuthOverview({
        provider: "amazon-bedrock",
        cfg: {},
        store: { version: 1, profiles: {} } as never,
        modelsPath: "/tmp/models.json",
      });
      expect(overview.effective.kind).toBe("env");
      expect(overview.effective.detail).toContain("aws-sdk");
      expect(overview.effective.detail).toContain("AWS_BEARER_TOKEN_BEDROCK");
      expect(overview.env).toBeDefined();
      expect(overview.env?.source).toBe("env: AWS_BEARER_TOKEN_BEDROCK");
    } finally {
      if (original === undefined) {
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      } else {
        process.env.AWS_BEARER_TOKEN_BEDROCK = original;
      }
    }
  });

  it("shows missing auth for amazon-bedrock when no AWS env vars are set", () => {
    const original = process.env.AWS_BEARER_TOKEN_BEDROCK;
    const origAccess = process.env.AWS_ACCESS_KEY_ID;
    const origSecret = process.env.AWS_SECRET_ACCESS_KEY;
    const origProfile = process.env.AWS_PROFILE;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_PROFILE;
    try {
      const overview = resolveProviderAuthOverview({
        provider: "amazon-bedrock",
        cfg: {},
        store: { version: 1, profiles: {} } as never,
        modelsPath: "/tmp/models.json",
      });
      expect(overview.effective.kind).toBe("missing");
      expect(overview.env).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env.AWS_BEARER_TOKEN_BEDROCK = original;
      }
      if (origAccess !== undefined) {
        process.env.AWS_ACCESS_KEY_ID = origAccess;
      }
      if (origSecret !== undefined) {
        process.env.AWS_SECRET_ACCESS_KEY = origSecret;
      }
      if (origProfile !== undefined) {
        process.env.AWS_PROFILE = origProfile;
      }
    }
  });

  it("does not show AWS SDK auth when Bedrock provider has auth override", () => {
    const original = process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token-value";
    try {
      const overview = resolveProviderAuthOverview({
        provider: "amazon-bedrock",
        cfg: {
          models: { providers: { "amazon-bedrock": { auth: "api-key", baseUrl: "", models: [] } } },
        } as never,
        store: { version: 1, profiles: {} } as never,
        modelsPath: "/tmp/models.json",
      });
      expect(overview.effective.kind).toBe("missing");
      expect(overview.env).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      } else {
        process.env.AWS_BEARER_TOKEN_BEDROCK = original;
      }
    }
  });
});
