/** Tests for core SecretRef assignment ownership, including standalone dictation. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectCoreConfigAssignments } from "./runtime-config-collectors-core.js";
import { createResolverContext } from "./runtime-shared.js";

const DICTATION_KEY_REF = {
  source: "env",
  provider: "default",
  id: "DICTATION_STT_KEY",
} as const;

function collect(config: OpenClawConfig) {
  const context = createResolverContext({ sourceConfig: {}, env: {} });
  collectCoreConfigAssignments({ config, defaults: undefined, context });
  return context;
}

describe("collectCoreConfigAssignments dictation", () => {
  it("assigns the selected provider to an isolated capability owner", () => {
    const config = {
      dictation: {
        provider: "openai-compatible-stt",
        providers: {
          "openai-compatible-stt": { apiKey: DICTATION_KEY_REF },
        },
      },
    } as OpenClawConfig;
    const context = collect(config);

    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]).toMatchObject({
      path: "dictation.providers.openai-compatible-stt.apiKey",
      expected: "string",
      ownerKind: "capability",
      ownerId: "dictation:openai-compatible-stt",
      requiredForGateway: false,
      disposition: "isolate",
    });
    context.assignments[0]?.apply("resolved-key");
    expect(config.dictation?.providers?.["openai-compatible-stt"]?.apiKey).toBe("resolved-key");
  });

  it("does not resolve inactive providers when one provider is selected", () => {
    const config = {
      dictation: {
        provider: "openai-compatible-stt",
        providers: {
          "openai-compatible-stt": { apiKey: DICTATION_KEY_REF },
          other: { apiKey: { ...DICTATION_KEY_REF, id: "OTHER_STT_KEY" } },
        },
      },
    } as OpenClawConfig;
    const context = collect(config);

    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]?.ownerId).toBe("dictation:openai-compatible-stt");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "dictation.providers.other.apiKey",
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        }),
      ]),
    );
  });
});
