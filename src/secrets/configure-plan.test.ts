import { describe, expect, it } from "vitest";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import {
  buildConfigureCandidatesForScope,
  buildSecretsConfigurePlan,
  collectConfigureProviderChanges,
  hasConfigurePlanChanges,
} from "./configure-plan.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

describe("secrets configure plan helpers", () => {
  it("collects provider upserts and deletes", () => {
    const envProvider = { source: "env" } as const;
    const original = { secrets: { providers: { default: envProvider, legacy: envProvider } } };
    const next = {
      secrets: {
        providers: {
          default: { ...envProvider, allowlist: ["OPENAI_API_KEY"] },
          modern: envProvider,
        },
      },
    };

    const changes = collectConfigureProviderChanges({ original, next });
    expect(Object.keys(changes.upserts).toSorted()).toEqual(["default", "modern"]);
    expect(changes.deletes).toEqual(["legacy"]);
  });

  it("captures existing refs for prefilled configure prompts", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {
        ...buildTalkTestProviderConfig(envRef("TALK_API_KEY")),
        channels: { telegram: { botToken: "token" }, nostr: { privateKey: "nostr-private-key" } },
      },
      authProfiles: {
        agentId: "main",
        store: createAuthProfileStoreFixture({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: envRef("OPENAI_API_KEY"),
          },
        }),
      },
    });

    expect(candidates.map(({ path, existingRef }) => [path, existingRef])).toStrictEqual(
      expect.arrayContaining([
        ["profiles.openai:default.key", envRef("OPENAI_API_KEY")],
        [TALK_TEST_PROVIDER_API_KEY_PATH, envRef("TALK_API_KEY")],
        ["channels.telegram.botToken", undefined],
        ["channels.nostr.privateKey", undefined],
      ]),
    );
  });

  it("reports configure change presence and builds deterministic plan shape", () => {
    const target = {
      type: "talk.providers.*.apiKey",
      path: TALK_TEST_PROVIDER_API_KEY_PATH,
      pathSegments: ["talk", "providers", TALK_TEST_PROVIDER_ID, "apiKey"],
      label: TALK_TEST_PROVIDER_API_KEY_PATH,
      configFile: "openclaw.json" as const,
      expectedResolvedValue: "string" as const,
      providerId: TALK_TEST_PROVIDER_ID,
      ref: envRef("TALK_API_KEY"),
    };
    const selected = new Map([[target.path, target]]);
    const providerChanges = { upserts: { default: { source: "env" as const } }, deletes: [] };
    expect(hasConfigurePlanChanges({ selectedTargets: selected, providerChanges })).toBe(true);

    const plan = buildSecretsConfigurePlan({
      selectedTargets: selected,
      providerChanges,
      generatedAt: "2026-02-28T00:00:00.000Z",
    });
    expect([plan.targets.map((entry) => entry.path), plan.providerUpserts, plan.options]).toEqual([
      [TALK_TEST_PROVIDER_API_KEY_PATH],
      { default: { source: "env" } },
      {
        scrubEnv: true,
        scrubAuthProfilesForProviderTargets: true,
        scrubLegacyAuthJson: false,
      },
    ]);
  });
});
