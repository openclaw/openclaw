/** Tests exec SecretRef id validation parity with provider contract helpers. */
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { SecretRefSchema as GatewaySecretRefSchema } from "../../packages/gateway-protocol/src/schema.js";
import { validateConfigObjectRaw } from "../config/validation.js";
import { buildSecretInputSchema } from "../plugin-sdk/secret-input-schema.js";
import {
  INVALID_FILE_SECRET_REF_IDS,
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_FILE_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import { isSecretsApplyPlan } from "./plan.js";
import { isValidExecSecretRefId, isValidFileSecretRefId } from "./ref-contract.js";

describe("exec SecretRef id parity", () => {
  const validateGatewaySecretRef = Compile(GatewaySecretRefSchema);
  const pluginSdkSecretInput = buildSecretInputSchema();
  const validEnvSecretRefIds = ["OPENAI_API_KEY", "A", "A_1", `A${"B".repeat(127)}`];
  const invalidEnvSecretRefIds = ["", "openai_api_key", "OPENAI-API-KEY", "1OPENAI", "A B"];

  function configAcceptsRef(ref: unknown): boolean {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: ref,
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });
    return result.ok;
  }

  function planAcceptsRef(ref: unknown) {
    return isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-03-10T00:00:00.000Z",
      generatedBy: "manual",
      targets: [
        {
          type: "talk.providers.*.apiKey",
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          providerId: TALK_TEST_PROVIDER_ID,
          ref,
        },
      ],
    });
  }

  for (const id of [...validEnvSecretRefIds, ...invalidEnvSecretRefIds]) {
    it(`keeps plan/gateway/plugin parity for env id "${id}"`, () => {
      const expected = validEnvSecretRefIds.includes(id);
      expect(planAcceptsRef({ source: "env", provider: "default", id })).toBe(expected);
      expect(validateGatewaySecretRef.Check({ source: "env", provider: "default", id })).toBe(
        expected,
      );
      expect(
        pluginSdkSecretInput.safeParse({ source: "env", provider: "default", id }).success,
      ).toBe(expected);
    });
  }

  for (const id of [...VALID_FILE_SECRET_REF_IDS, ...INVALID_FILE_SECRET_REF_IDS]) {
    it(`keeps config/gateway/plugin parity for file id "${id}"`, () => {
      const expected = isValidFileSecretRefId(id);
      expect(configAcceptsRef({ source: "file", provider: "default", id })).toBe(expected);
      expect(planAcceptsRef({ source: "file", provider: "default", id })).toBe(expected);
      expect(validateGatewaySecretRef.Check({ source: "file", provider: "default", id })).toBe(
        expected,
      );
      expect(
        pluginSdkSecretInput.safeParse({ source: "file", provider: "default", id }).success,
      ).toBe(expected);
    });
  }

  it("rejects invalid provider aliases across plan/gateway/plugin refs", () => {
    const ref = { source: "env" as const, provider: "Default", id: "OPENAI_API_KEY" };

    expect(planAcceptsRef(ref)).toBe(false);
    expect(validateGatewaySecretRef.Check(ref)).toBe(false);
    expect(pluginSdkSecretInput.safeParse(ref).success).toBe(false);
  });

  for (const ref of [
    { source: "env", provider: "default", id: "OPENAI_API_KEY", extra: "x" },
    { source: "file", provider: "default", id: "value", extra: "x" },
    { source: "exec", provider: "vault", id: "vault/openai/api-key", extra: "x" },
  ]) {
    it(`rejects non-canonical ${ref.source} refs with extra properties across config/plan/gateway/plugin`, () => {
      expect(configAcceptsRef(ref)).toBe(false);
      expect(planAcceptsRef(ref)).toBe(false);
      expect(validateGatewaySecretRef.Check(ref)).toBe(false);
      expect(pluginSdkSecretInput.safeParse(ref).success).toBe(false);
    });
  }

  for (const id of [...VALID_EXEC_SECRET_REF_IDS, ...INVALID_EXEC_SECRET_REF_IDS]) {
    it(`keeps config/plan/gateway/plugin parity for exec id "${id}"`, () => {
      const expected = isValidExecSecretRefId(id);
      expect(configAcceptsRef({ source: "exec", provider: "vault", id })).toBe(expected);
      expect(planAcceptsRef({ source: "exec", provider: "vault", id })).toBe(expected);
      expect(validateGatewaySecretRef.Check({ source: "exec", provider: "vault", id })).toBe(
        expected,
      );
      expect(
        pluginSdkSecretInput.safeParse({ source: "exec", provider: "vault", id }).success,
      ).toBe(expected);
    });
  }
});
