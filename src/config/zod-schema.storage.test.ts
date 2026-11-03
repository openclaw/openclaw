import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const passphrase = { source: "env", provider: "default", id: "STORAGE_PASSPHRASE" };
function location(overrides: Record<string, unknown> = {}, name = "archive") {
  return {
    storage: {
      locations: {
        [name]: {
          provider: "filesystem",
          settings: { path: "/mnt/archive/openclaw" },
          encryption: { passphrase },
          ...overrides,
        },
      },
    },
  };
}

describe("OpenClawSchema storage config", () => {
  it.each([{ passphrase }, "none"])(
    "preserves encryption and nested SecretRefs: %j",
    (encryption) => {
      const config = location({
        encryption,
        provider: "example-provider",
        settings: {
          accountId: "example-account",
          bucket: "example-bucket",
          accessKeyId: { source: "env", provider: "default", id: "STORAGE_ACCESS_KEY_ID" },
          auth: [{ secretAccessKey: { source: "env", provider: "default", id: "STORAGE_SECRET" } }],
        },
      });
      expect(OpenClawSchema.parse(config).storage).toEqual(config.storage);
    },
  );

  it.each([
    ...[undefined, { passphrase: 123 }].map((encryption) => ({
      config: location({ encryption }),
      issue: { path: ["storage", "locations", "archive", "encryption"] },
    })),
    { config: location({}, "Archive"), issue: {} },
    ...[
      { accessKeyId: "example-key-not-real" },
      { auth: [{ secretAccessKey: "example-secret-not-real" }] },
      { auth: { passphrase: "example-passphrase-not-real" } },
      { keyRef: { source: "env", provider: "default", id: "invalid-id" } },
    ].map((settings) => ({
      config: location({ settings }),
      issue: { message: expect.stringContaining("must use a SecretRef") },
    })),
    {
      config: location({ settings: { timeout: Infinity } }),
      issue: { message: "Storage location settings must be bounded finite JSON" },
    },
  ])("rejects invalid storage configuration %#", ({ config, issue }) => {
    const result = OpenClawSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject(issue);
    }
  });
});
