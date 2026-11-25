/**
 * Tests secret input parsing, normalization, and configured secret resolution.
 */
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import { buildSecretInputSchema } from "./secret-input-schema.js";
import {
  buildOptionalSecretInputSchema,
  buildSecretInputArraySchema,
  normalizeSecretInputString,
  readProviderEnvValue,
} from "./secret-input.js";

describe("plugin-sdk secret input helpers", () => {
  it.each([
    { primary: " first ", fallback: "second", expected: "first" },
    { primary: " \n ", fallback: " usable\r\nkey ", expected: "usablekey" },
    { primary: "\u2028\u200b", fallback: undefined, expected: undefined },
  ])("reads the first normalized nonempty provider env value ($expected)", (testCase) => {
    withEnv(
      {
        OPENCLAW_TEST_PROVIDER_PRIMARY: testCase.primary,
        OPENCLAW_TEST_PROVIDER_FALLBACK: testCase.fallback,
      },
      () => {
        expect(
          readProviderEnvValue([
            "OPENCLAW_TEST_PROVIDER_PRIMARY",
            "OPENCLAW_TEST_PROVIDER_FALLBACK",
          ]),
        ).toBe(testCase.expected);
      },
    );
  });

  it.each([
    {
      name: "accepts undefined for optional secret input",
      run: () => buildOptionalSecretInputSchema().safeParse(undefined).success,
      expected: true,
    },
    {
      name: "accepts arrays of secret inputs",
      run: () =>
        buildSecretInputArraySchema().safeParse([
          "sk-plain",
          { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        ]).success,
      expected: true,
    },
    {
      name: "normalizes plaintext secret strings",
      run: () => normalizeSecretInputString("  sk-test  "),
      expected: "sk-test",
    },
  ])("$name", ({ run, expected }) => {
    expect(run()).toEqual(expected);
  });
});

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
    expect(
      schema.safeParse({ source: "store", provider: "default", id: "STORED_API_KEY" }).success,
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

  it("rejects store refs outside the env-name grammar", () => {
    expect(
      schema.safeParse({ source: "store", provider: "default", id: "lowercase" }).success,
    ).toBe(false);
  });
});
