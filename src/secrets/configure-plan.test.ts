import { beforeAll, describe, expect, it } from "vitest";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import type { OpenClawConfig } from "../config/config.js";
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
import { resolveConfigSecretTargetByPath } from "./target-registry.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

describe("secrets configure plan helpers", () => {
  beforeAll(() => {
    resolveConfigSecretTargetByPath(["channels", "telegram", "botToken"]);
    buildConfigureCandidatesForScope({ config: {} as OpenClawConfig });
  });

  it("builds configure candidates from supported configure targets", () => {
    const config = {
      ...buildTalkTestProviderConfig("plain"),
      channels: {
        telegram: { botToken: "token" }, // pragma: allowlist secret
        nostr: { privateKey: "nostr-private-key" }, // pragma: allowlist secret
      },
    } as OpenClawConfig;

    const candidates = buildConfigureCandidatesForScope({ config });
    const paths = candidates.map((entry) => entry.path);
    expect(paths).toContain(TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(paths).toContain("channels.telegram.botToken");
    expect(paths).toContain("channels.nostr.privateKey");
    expect(resolveConfigSecretTargetByPath(["channels", "nostr", "privateKey"])).toMatchObject({
      entry: {
        id: "channels.nostr.privateKey",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
    });
  });

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
      config: buildTalkTestProviderConfig(envRef("TALK_API_KEY")),
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

    const talkCandidate = candidates.find(
      (entry) => entry.path === TALK_TEST_PROVIDER_API_KEY_PATH,
    );
    expect(talkCandidate?.existingRef).toStrictEqual(envRef("TALK_API_KEY"));

    const openaiCandidate = candidates.find(
      (entry) => entry.path === "profiles.openai:default.key",
    );
    expect(openaiCandidate?.existingRef).toStrictEqual(envRef("OPENAI_API_KEY"));
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
    expect(plan.targets.map((entry) => entry.path)).toEqual([TALK_TEST_PROVIDER_API_KEY_PATH]);
    expect(plan.providerUpserts).toEqual({
      default: { source: "env" },
    });
    expect(plan.options).toEqual({
      scrubEnv: true,
      scrubAuthProfilesForProviderTargets: true,
      scrubLegacyAuthJson: false,
    });
  });
});
