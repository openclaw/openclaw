import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../../test-utils/secret-ref-test-vectors.js";
import { SecretInputSchema, SecretRefSchema } from "./schema/primitives.js";

describe("gateway protocol SecretRef schema", () => {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateSecretRef = ajv.compile(SecretRefSchema);
  const validateSecretInput = ajv.compile(SecretInputSchema);

  it("accepts valid source-specific refs", () => {
    expect(validateSecretRef({ source: "env", provider: "default", id: "OPENAI_API_KEY" })).toBe(
      true,
    );
    expect(
      validateSecretRef({ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }),
    ).toBe(true);
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      expect(validateSecretRef({ source: "exec", provider: "vault", id }), id).toBe(true);
      expect(validateSecretInput({ source: "exec", provider: "vault", id }), id).toBe(true);
    }
  });

  it("rejects invalid exec refs", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      expect(validateSecretRef({ source: "exec", provider: "vault", id }), id).toBe(false);
      expect(validateSecretInput({ source: "exec", provider: "vault", id }), id).toBe(false);
    }
  });

  it("accepts plugin-owned SecretRef sources (e.g. gcp, keyring) on the wire", () => {
    expect(validateSecretRef({ source: "gcp", provider: "my-gcp", id: "OPENAI_API_KEY" })).toBe(
      true,
    );
    expect(
      validateSecretRef({ source: "keyring", provider: "default", id: "openai-api-key" }),
    ).toBe(true);
    // SecretInput must also accept plugin SecretRefs (it's the wire form for
    // fields like `talkProviderFieldSchemas.apiKey`).
    expect(validateSecretInput({ source: "aws", provider: "ops", id: "db/password" })).toBe(true);
  });

  it("does not let the plugin arm silently rescue malformed built-in refs", () => {
    // A built-in source with a malformed id must fail the strict per-source
    // schema and NOT fall through to the permissive plugin arm. The plugin
    // arm's source-pattern excludes the three built-in literals.
    expect(validateSecretRef({ source: "env", provider: "default", id: "lowercase-id" })).toBe(
      false,
    );
    expect(validateSecretRef({ source: "file", provider: "filemain", id: "relative/path" })).toBe(
      false,
    );
  });

  it("rejects empty / missing plugin source strings", () => {
    expect(validateSecretRef({ source: "", provider: "p", id: "i" })).toBe(false);
    expect(validateSecretRef({ provider: "p", id: "i" })).toBe(false);
    expect(validateSecretRef({ source: "gcp", provider: "p", id: "" })).toBe(false);
  });
});
