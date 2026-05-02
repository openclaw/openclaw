import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
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
      },
    } as OpenClawConfig;

    const candidates = buildConfigureCandidates(config);
    const paths = candidates.map((entry) => entry.path);
    expect(paths).toContain(TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(paths).toContain("channels.telegram.botToken");
  });

  it("surfaces only likely credential-like core mcp env and header fields as configure candidates", () => {
    const config = {
      mcp: {
        servers: {
          "mission-control": {
            env: {
              MC_URL: "http://127.0.0.1:3000",
              MC_API_KEY: "plaintext-mcp-api-key", // pragma: allowlist secret
              AUTH: "plaintext-mcp-auth", // pragma: allowlist secret
              SERVICE_KEY: "plaintext-service-key", // pragma: allowlist secret
              AUTH_ENABLED: "enabled",
              TOKEN_REFRESH: "disabled",
              PROFILE: "Bearer plaintext-profile-token", // pragma: allowlist secret
              DASHBOARD_URL: "https://service.example?api_key=plaintext-url-secret", // pragma: allowlist secret
              CONFIG_SLOT: {
                source: "env",
                provider: "default",
                id: "CONFIG_SLOT_SECRET",
              },
            },
            headers: {
              "X-Feature-Flag": "enabled",
              Authorization: "Bearer plaintext-mcp-header", // pragma: allowlist secret
              "X-Custom-Auth": "plaintext-custom-mcp-header", // pragma: allowlist secret
              "X-Access-Key": "plaintext-access-key", // pragma: allowlist secret
              "X-Auth-Mode": "enabled",
              "X-Token-Refresh": "disabled",
              "X-Relay": "Bearer plaintext-relay-token", // pragma: allowlist secret
              "X-Endpoint": "https://example.invalid/mcp?token=plaintext-query-secret", // pragma: allowlist secret
              "X-Config": {
                source: "env",
                provider: "default",
                id: "X_CONFIG_SECRET",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const paths = buildConfigureCandidates(config).map((entry) => entry.path);
    expect(paths).toContain("mcp.servers.mission-control.env.MC_API_KEY");
    expect(paths).toContain("mcp.servers.mission-control.env.AUTH");
    expect(paths).toContain("mcp.servers.mission-control.env.SERVICE_KEY");
    expect(paths).toContain("mcp.servers.mission-control.headers.Authorization");
    expect(paths).toContain("mcp.servers.mission-control.headers.X-Custom-Auth");
    expect(paths).toContain("mcp.servers.mission-control.headers.X-Access-Key");
    expect(paths).toContain("mcp.servers.mission-control.env.PROFILE");
    expect(paths).toContain("mcp.servers.mission-control.env.DASHBOARD_URL");
    expect(paths).toContain("mcp.servers.mission-control.env.CONFIG_SLOT");
    expect(paths).toContain("mcp.servers.mission-control.headers.X-Relay");
    expect(paths).toContain("mcp.servers.mission-control.headers.X-Endpoint");
    expect(paths).toContain("mcp.servers.mission-control.headers.X-Config");
    expect(paths).not.toContain("mcp.servers.mission-control.env.AUTH_ENABLED");
    expect(paths).not.toContain("mcp.servers.mission-control.env.TOKEN_REFRESH");
    expect(paths).not.toContain("mcp.servers.mission-control.env.MC_URL");
    expect(paths).not.toContain("mcp.servers.mission-control.headers.X-Auth-Mode");
    expect(paths).not.toContain("mcp.servers.mission-control.headers.X-Token-Refresh");
    expect(paths).not.toContain("mcp.servers.mission-control.headers.X-Feature-Flag");
  });

  it("surfaces numeric-only MCP values when the key name is credential-like", () => {
    const config = {
      mcp: {
        servers: {
          demo: {
            env: {
              API_KEY: "123456", // pragma: allowlist secret
              RETRY_COUNT: "3000",
            },
            headers: {
              Authorization: "123456", // pragma: allowlist secret
              "X-Retry-Count": "3000",
            },
          },
        },
      },
    } as OpenClawConfig;

    const paths = buildConfigureCandidates(config).map((entry) => entry.path);
    expect(paths).toContain("mcp.servers.demo.env.API_KEY");
    expect(paths).toContain("mcp.servers.demo.headers.Authorization");
    expect(paths).not.toContain("mcp.servers.demo.env.RETRY_COUNT");
    expect(paths).not.toContain("mcp.servers.demo.headers.X-Retry-Count");
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

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
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
            id: "OPENAI_API_KEY", // pragma: allowlist secret
          },
        }),
      ]),
    );
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
    expect(plan.providerUpserts).toBeDefined();
    expect(plan.options).toEqual({
      scrubEnv: true,
      scrubAuthProfilesForProviderTargets: true,
      scrubLegacyAuthJson: true,
    });
  });
});
