import { Compile } from "typebox/compile";
import { expect, it } from "vitest";
import { SecretRefSchema as GatewaySecretRefSchema } from "../../packages/gateway-protocol/src/schema.js";
import { validateConfigObjectRaw } from "../config/validation.js";
import { buildSecretInputSchema } from "../plugin-sdk/secret-input-schema.js";
import {
  INVALID_FILE_SECRET_REF_IDS as invalidFileIds,
  INVALID_EXEC_SECRET_REF_IDS as invalidExecIds,
  VALID_FILE_SECRET_REF_IDS as validFileIds,
  VALID_EXEC_SECRET_REF_IDS as validExecIds,
} from "../test-utils/secret-ref-test-vectors.js";
import { createOpenAiProviderConfig } from "./apply.test-support.js";
import { isSecretsApplyPlan, type SecretsPlanTarget } from "./plan.js";
import { listSecretTargetRegistryEntries } from "./target-registry.js";

it.each(["tools.github.app.privateKey", "agents.entries.*.tools.github.app.privateKey"])(
  "rejects traversal exec refs on the registered App key surface %s",
  (targetType) => {
    const entry = listSecretTargetRegistryEntries().find((t) => t.targetType === targetType);
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

function planAcceptsRef(
  ref: unknown,
  target: Omit<SecretsPlanTarget, "ref"> = {
    type: "models.providers.*.apiKey",
    path: "models.providers.openai.apiKey",
    pathSegments: ["models", "providers", "openai", "apiKey"],
    providerId: "openai",
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
    expect(
      validateConfigObjectRaw({
        models: { providers: { openai: createOpenAiProviderConfig(ref) } },
      }).ok,
    ).toBe(expected);
  }
  expect(planAcceptsRef(ref)).toBe(expected);
  expect(validateGatewaySecretRef.Check(ref)).toBe(expected);
  expect(pluginSdkSecretInput.safeParse(ref).success).toBe(expected);
}

for (const [source, provider, validIds, invalidIds] of [
  ["env", "default", validEnvIds, invalidEnvIds],
  ["file", "default", validFileIds, invalidFileIds],
  ["exec", "vault", validExecIds, invalidExecIds],
] as const) {
  for (const [ids, expected] of [
    [validIds, true],
    [invalidIds, false],
  ] as const) {
    it.each(ids)(`keeps ${source} ref parity for id "%s"`, (id) => {
      expectParity({ source, provider, id }, expected, source !== "env");
    });
  }
}

it("rejects invalid provider aliases across plan/gateway/plugin refs", () => {
  expectParity({ source: "env", provider: "Default", id: "OPENAI_API_KEY" }, false, false);
});

it.each([
  { source: "env", provider: "default", id: "OPENAI_API_KEY", extra: "x" },
  { source: "file", provider: "default", id: "value", extra: "x" },
  { source: "exec", provider: "vault", id: "vault/openai/api-key", extra: "x" },
])("rejects extra ref properties: $source", (ref) => expectParity(ref, false));
