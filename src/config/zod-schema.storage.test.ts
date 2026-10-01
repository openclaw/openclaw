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
  it.each([{ passphrase }, "none"])("preserves an explicit encryption choice: %j", (encryption) => {
    const config = location({ encryption });
    expect(OpenClawSchema.parse(config).storage).toEqual(config.storage);
  });

  it.each([undefined, {}, "aes256", { passphrase: 123 }])(
    "rejects missing or invalid encryption: %j",
    (encryption) => {
      const result = OpenClawSchema.safeParse(location({ encryption }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual([
          "storage",
          "locations",
          "archive",
          "encryption",
        ]);
      }
    },
  );

  it.each(["", "Archive", "-archive", "archive_disk", "a".repeat(64)])(
    "rejects an invalid location name: %s",
    (name) => {
      expect(OpenClawSchema.safeParse(location({}, name)).success).toBe(false);
    },
  );

  it("accepts provider settings with nested secret references", () => {
    const settings = {
      accountId: "example-account",
      bucket: "example-bucket",
      accessKeyId: { source: "env", provider: "default", id: "STORAGE_ACCESS_KEY_ID" },
      auth: [{ secretAccessKey: { source: "env", provider: "default", id: "STORAGE_SECRET" } }],
    };
    const config = location({ provider: "example-provider", settings });
    expect(OpenClawSchema.parse(config).storage).toEqual(config.storage);
  });

  it.each([
    { accessKeyId: "example-key-not-real" },
    { auth: [{ secretAccessKey: "example-secret-not-real" }] },
    { auth: { passphrase: "example-passphrase-not-real" } },
    { keyRef: { source: "env", provider: "default", id: "invalid-id" } },
  ])("rejects plaintext or malformed provider credentials: %j", (settings) => {
    const result = OpenClawSchema.safeParse(location({ settings }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("must use a SecretRef");
    }
  });

  it.each([{ timeout: Infinity }, { path: "a".repeat(65_537) }])(
    "rejects nonfinite or oversized provider settings %#",
    (settings) => {
      const result = OpenClawSchema.safeParse(location({ settings }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "Storage location settings must be bounded finite JSON",
        );
      }
    },
  );
});
