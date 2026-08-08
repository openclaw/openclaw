// Covers schema acceptance for security.allowAmbientProviderKeys.
import { describe, expect, it } from "vitest";
import { SecuritySchema } from "./zod-schema.root-support.js";

describe("security.allowAmbientProviderKeys schema", () => {
  it("accepts the setting when disabled", () => {
    const parsed = SecuritySchema.parse({ allowAmbientProviderKeys: false });
    expect(parsed).toEqual({ allowAmbientProviderKeys: false });
  });

  it("accepts the setting alongside existing security keys", () => {
    const parsed = SecuritySchema.parse({
      allowAmbientProviderKeys: true,
      installPolicy: { enabled: true },
    });
    expect(parsed).toMatchObject({ allowAmbientProviderKeys: true });
  });

  it("stays optional so existing configs are unaffected", () => {
    expect(SecuritySchema.parse({})).toEqual({});
    expect(SecuritySchema.parse(undefined)).toBeUndefined();
  });

  it("rejects a non-boolean value", () => {
    expect(() => SecuritySchema.parse({ allowAmbientProviderKeys: "false" })).toThrow();
  });
});
