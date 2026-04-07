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
});
