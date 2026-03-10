import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import { buildSecretInputSchema } from "./secret-input-schema.js";

describe("plugin-sdk secret input schema", () => {
  const schema = buildSecretInputSchema();

  it("accepts plaintext and valid refs", () => {
    expect(schema.safeParse("sk-plain").success).toBe(true);
    expect(
      schema.safeParse({ source: "env", provider: "default", id: "OPENAI_API_KEY" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ source: "file", provider: "filemain", id: "/providers/openai/apiKey" })
        .success,
    ).toBe(true);
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      expect(schema.safeParse({ source: "exec", provider: "vault", id }).success, id).toBe(true);
    }
  });

  it("rejects invalid exec refs", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      expect(schema.safeParse({ source: "exec", provider: "vault", id }).success, id).toBe(false);
    }
  });
});
