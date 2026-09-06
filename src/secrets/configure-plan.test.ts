/** Tests secrets configure plan generation and target validation. */
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
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

describe("secrets configure plan helpers", () => {
  beforeAll(() => {
    resolveConfigSecretTargetByPath(["channels", "telegram", "botToken"]);
    buildConfigureCandidatesForScope({ config: {} as OpenClawConfig });
  });

  it("builds configure candidates from supported configure targets", () => {
    const config = {
      talk: {
        providers: {
          [TALK_TEST_PROVIDER_ID]: {
            apiKey: "plain", // pragma: allowlist secret
          },
        },
      },
      channels: {
        telegram: {
          botToken: "token", // pragma: allowlist secret
        },
        nostr: {
          privateKey: "nostr-private-key", // pragma: allowlist secret
        },
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
    const original = {
      secrets: {
        providers: {
          default: { source: "env" },
          legacy: { source: "env" },
        },
      },
    } as OpenClawConfig;
    const next = {
      secrets: {
        providers: {
          default: { source: "env", allowlist: ["OPENAI_API_KEY"] },
          modern: { source: "env" },
        },
      },
    } as OpenClawConfig;

    const changes = collectConfigureProviderChanges({ original, next });
    expect(Object.keys(changes.upserts).toSorted()).toEqual(["default", "modern"]);
    expect(changes.deletes).toEqual(["legacy"]);
  });

  it("discovers auth-profiles candidates for the selected agent scope", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {} as OpenClawConfig,
      authProfiles: {
        agentId: "main",
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk",
            },
          },
        },
      },
    });
    const openaiCandidate = candidates.find(
      (entry) => entry.path === "profiles.openai:default.key",
    );
    expect(openaiCandidate?.type).toBe("auth-profiles.api_key.key");
    expect(openaiCandidate?.agentId).toBe("main");
    expect(openaiCandidate?.configFile).toBe("auth-profile-store");
    expect(openaiCandidate?.authProfileProvider).toBe("openai");
  });

  it("captures existing refs for prefilled configure prompts", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {
        talk: {
          providers: {
            [TALK_TEST_PROVIDER_ID]: {
              apiKey: {
                source: "env",
                provider: "default",
                id: "TALK_API_KEY",
              },
            },
          },
        },
      } as OpenClawConfig,
      authProfiles: {
        agentId: "main",
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              keyRef: {
                source: "env",
                provider: "default",
                id: "OPENAI_API_KEY",
              },
            },
          },
        },
      },
    });

    const talkCandidate = candidates.find(
      (entry) => entry.path === TALK_TEST_PROVIDER_API_KEY_PATH,
    );
    expect(talkCandidate?.existingRef).toStrictEqual({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });

    const openaiCandidate = candidates.find(
      (entry) => entry.path === "profiles.openai:default.key",
    );
    expect(openaiCandidate?.existingRef).toStrictEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY", // pragma: allowlist secret
    });
  });

  it("marks normalized alias paths as derived when not authored directly", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {
        talk: {
          provider: TALK_TEST_PROVIDER_ID,
          providers: {
            [TALK_TEST_PROVIDER_ID]: {
              apiKey: "demo-talk-key", // pragma: allowlist secret
            },
          },
          apiKey: "demo-talk-key", // pragma: allowlist secret
        },
      } as OpenClawConfig,
      authoredOpenClawConfig: {
        talk: {
          apiKey: "demo-talk-key", // pragma: allowlist secret
        },
      } as OpenClawConfig,
    });

    const normalized = candidates.find((entry) => entry.path === TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(normalized?.isDerived).toBe(true);
  });

  it("reports configure change presence and builds deterministic plan shape", () => {
    const selected = new Map([
      [
        TALK_TEST_PROVIDER_API_KEY_PATH,
        {
          type: "talk.providers.*.apiKey",
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: ["talk", "providers", TALK_TEST_PROVIDER_ID, "apiKey"],
          label: TALK_TEST_PROVIDER_API_KEY_PATH,
          configFile: "openclaw.json" as const,
          expectedResolvedValue: "string" as const,
          providerId: TALK_TEST_PROVIDER_ID,
          ref: {
            source: "env" as const,
            provider: "default",
            id: "TALK_API_KEY",
          },
        },
      ],
    ]);
    const providerChanges = {
      upserts: {
        default: { source: "env" as const },
      },
      deletes: [],
    };
    expect(
      hasConfigurePlanChanges({
        selectedTargets: selected,
        providerChanges,
      }),
    ).toBe(true);

    const plan = buildSecretsConfigurePlan({
      selectedTargets: selected,
      providerChanges,
      generatedAt: "2026-02-28T00:00:00.000Z",
    });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.path).toBe(TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(plan.providerUpserts).toEqual({
      default: { source: "env" },
    });
    expect(plan.options).toEqual({
      scrubEnv: true,
      scrubAuthProfilesForProviderTargets: true,
      scrubLegacyAuthJson: false,
    });
  });

  it("emits protocolVersion 2 and omits agentId for shared auth-profile targets", () => {
    const sharedTarget = {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:shared.key",
      pathSegments: ["profiles", "openai:shared", "key"],
      label: "profiles.openai:shared.key (auth profile, shared)",
      configFile: "auth-profile-store" as const,
      expectedResolvedValue: "string" as const,
      agentId: "main",
      authProfileStore: "shared" as "shared" | "agent",
      ref: {
        source: "env" as const,
        provider: "default",
        id: "OPENAI_API_KEY",
      },
    };
    const agentTarget = {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:agent.key",
      pathSegments: ["profiles", "openai:agent", "key"],
      label: "profiles.openai:agent.key (auth profile, agent main)",
      configFile: "auth-profile-store" as const,
      expectedResolvedValue: "string" as const,
      agentId: "main",
      authProfileStore: "agent" as "shared" | "agent",
      ref: {
        source: "env" as const,
        provider: "default",
        id: "OPENAI_API_KEY",
      },
    };
    const selected = new Map([
      ["profiles.openai:shared.key", sharedTarget],
      ["profiles.openai:agent.key", agentTarget],
    ]);
    const plan = buildSecretsConfigurePlan({
      selectedTargets: selected,
      providerChanges: { upserts: {}, deletes: [] },
    });
    const sharedPlanTarget = plan.targets.find((t) => t.path.includes("openai:shared"));
    const agentPlanTarget = plan.targets.find((t) => t.path.includes("openai:agent"));
    // A plan with shared targets must use protocolVersion 2 so older v1-only
    // clients reject it at the version check instead of silently routing by
    // agentId (which shared targets omit).
    expect(plan.protocolVersion).toBe(2);
    // Shared targets must NOT carry agentId.
    expect(sharedPlanTarget?.agentId).toBeUndefined();
    expect(sharedPlanTarget?.authProfileStore).toBe("shared");
    // Agent targets still carry agentId for backward compatibility.
    expect(agentPlanTarget?.agentId).toBe("main");
    expect(agentPlanTarget?.authProfileStore).toBe("agent");
  });

  it("emits protocolVersion 1 when no shared auth-profile targets are selected", () => {
    const agentTarget = {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:agent.key",
      pathSegments: ["profiles", "openai:agent", "key"],
      label: "profiles.openai:agent.key (auth profile, agent main)",
      configFile: "auth-profile-store" as const,
      expectedResolvedValue: "string" as const,
      agentId: "main",
      authProfileStore: "agent" as "shared" | "agent",
      ref: {
        source: "env" as const,
        provider: "default",
        id: "OPENAI_API_KEY",
      },
    };
    const selected = new Map([["profiles.openai:agent.key", agentTarget]]);
    const plan = buildSecretsConfigurePlan({
      selectedTargets: selected,
      providerChanges: { upserts: {}, deletes: [] },
    });
    expect(plan.protocolVersion).toBe(1);
  });
});
