import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildConfigureCandidates,
  buildConfigureCandidatesForScope,
  buildSecretsConfigurePlan,
  collectConfigureProviderChanges,
  hasConfigurePlanChanges,
} from "./configure-plan.js";

describe("secrets configure plan helpers", () => {
  it("builds configure candidates from supported configure targets", () => {
    const config = {
      talk: {
        apiKey: "plain",
      },
      channels: {
        telegram: {
          botToken: "token",
        },
      },
    } as OpenClawConfig;

    const candidates = buildConfigureCandidates(config);
    const paths = candidates.map((entry) => entry.path);
    expect(paths).toContain("talk.apiKey");
    expect(paths).toContain("channels.telegram.botToken");
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
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "auth-profiles.api_key.key",
          path: "profiles.openai:default.key",
          agentId: "main",
          configFile: "auth-profiles.json",
          authProfileProvider: "openai",
        }),
      ]),
    );
  });

  it("captures existing refs for prefilled configure prompts", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {
        talk: {
          apiKey: {
            source: "env",
            provider: "default",
            id: "TALK_API_KEY",
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

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "talk.apiKey",
          existingRef: {
            source: "env",
            provider: "default",
            id: "TALK_API_KEY",
          },
        }),
        expect.objectContaining({
          path: "profiles.openai:default.key",
          existingRef: {
            source: "env",
            provider: "default",
            id: "OPENAI_API_KEY",
          },
        }),
      ]),
    );
  });

  it("marks normalized alias paths as derived when not authored directly", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {
        talk: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              apiKey: "demo-talk-key",
            },
          },
          apiKey: "demo-talk-key",
        },
      } as OpenClawConfig,
      authoredOpenClawConfig: {
        talk: {
          apiKey: "demo-talk-key",
        },
      } as OpenClawConfig,
    });

    const legacy = candidates.find((entry) => entry.path === "talk.apiKey");
    const normalized = candidates.find(
      (entry) => entry.path === "talk.providers.elevenlabs.apiKey",
    );
    expect(legacy?.isDerived).not.toBe(true);
    expect(normalized?.isDerived).toBe(true);
  });

  it("reports configure change presence and builds deterministic plan shape", () => {
    const selected = new Map([
      [
        "talk.apiKey",
        {
          type: "talk.apiKey",
          path: "talk.apiKey",
          pathSegments: ["talk", "apiKey"],
          label: "talk.apiKey",
          configFile: "openclaw.json" as const,
          expectedResolvedValue: "string" as const,
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
    expect(plan.targets[0]?.path).toBe("talk.apiKey");
    expect(plan.providerUpserts).toBeDefined();
    expect(plan.options).toEqual({
      scrubEnv: true,
      scrubAuthProfilesForProviderTargets: true,
      scrubLegacyAuthJson: true,
    });
  });
});
