import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { SecretRefSchema as GatewaySecretRefSchema } from "../../packages/gateway-protocol/src/schema.js";
import { validateConfigObjectRaw } from "../config/validation.js";
import { buildSecretInputSchema } from "../plugin-sdk/secret-input-schema.js";
import {
  INVALID_FILE_SECRET_REF_IDS as invalidFileIds,
  INVALID_EXEC_SECRET_REF_IDS as invalidExecIds,
  VALID_FILE_SECRET_REF_IDS as validFileIds,
  VALID_EXEC_SECRET_REF_IDS as validExecIds,
} from "../test-utils/secret-ref-test-vectors.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import { isSecretsApplyPlan, type SecretsPlanTarget } from "./plan.js";
import { isValidExecSecretRefId, isValidFileSecretRefId } from "./ref-contract.js";
import { listSecretTargetRegistryEntries } from "./target-registry.js";

describe("exec SecretRef id parity", () => {
  it.each(["tools.github.app.privateKey", "agents.entries.*.tools.github.app.privateKey"])(
    "rejects traversal exec refs on the registered App key surface %s",
    (targetType) => {
      const entry = listSecretTargetRegistryEntries().find(
        (target) => target.targetType === targetType,
      );
      expect(entry?.includeInPlan).toBe(true);
      const pathSegments = targetType.split(".").map((part) => (part === "*" ? "main" : part));
      const target = { type: targetType, path: pathSegments.join("."), pathSegments };
      const accepts = (id: string) =>
        planAcceptsRef({ source: "exec", provider: "vault", id }, target);
      expect(accepts("apps/signing-key")).toBe(true);
      expect(accepts("../apps/signing-key")).toBe(false);
    },
  );
  const validateGatewaySecretRef = Compile(GatewaySecretRefSchema);
  const pluginSdkSecretInput = buildSecretInputSchema();
  const validEnvIds = ["OPENAI_API_KEY", "A", "A_1", `A${"B".repeat(127)}`];
  const invalidEnvIds = ["", "openai_api_key", "OPENAI-API-KEY", "1OPENAI", "A B"];
  const isValidEnvId = (id: string) => validEnvIds.includes(id);

  function configAcceptsRef(ref: unknown): boolean {
    return validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: ref,
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    }).ok;
  }

  function planAcceptsRef(
    ref: unknown,
    target: Omit<SecretsPlanTarget, "ref"> = {
      type: "talk.providers.*.apiKey",
      path: TALK_TEST_PROVIDER_API_KEY_PATH,
      pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
      providerId: TALK_TEST_PROVIDER_ID,
    },
  ) {
    return isSecretsApplyPlan({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-03-10T00:00:00.000Z",
      generatedBy: "manual",
      targets: [{ ...target, ref }],
    });
  }

  function expectParity(ref: unknown, expected: boolean, checkConfig = true) {
    if (checkConfig) {
      expect(configAcceptsRef(ref)).toBe(expected);
    }
    expect(planAcceptsRef(ref)).toBe(expected);
    expect(validateGatewaySecretRef.Check(ref)).toBe(expected);
    expect(pluginSdkSecretInput.safeParse(ref).success).toBe(expected);
  }

  for (const [source, provider, ids, valid] of [
    ["env", "default", [...validEnvIds, ...invalidEnvIds], isValidEnvId],
    ["file", "default", [...validFileIds, ...invalidFileIds], isValidFileSecretRefId],
    ["exec", "vault", [...validExecIds, ...invalidExecIds], isValidExecSecretRefId],
  ] as const) {
    for (const id of ids) {
      it(`keeps ${source} ref parity for id "${id}"`, () => {
        expectParity({ source, provider, id }, valid(id), source !== "env");
      });
    }
  }

  it("rejects invalid provider aliases across plan/gateway/plugin refs", () => {
    expectParity({ source: "env", provider: "Default", id: "OPENAI_API_KEY" }, false, false);
  });

  for (const ref of [
    { source: "env", provider: "default", id: "OPENAI_API_KEY", extra: "x" },
    { source: "file", provider: "default", id: "value", extra: "x" },
    { source: "exec", provider: "vault", id: "vault/openai/api-key", extra: "x" },
  ]) {
    it(`rejects non-canonical ${ref.source} refs with extra properties across config/plan/gateway/plugin`, () => {
      expectParity(ref, false);
    });
  }
});
