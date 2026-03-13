import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";
import { OLLAMA_LOCAL_AUTH_MARKER } from "../../agents/model-auth-markers.js";

let mockStore: AuthProfileStore;
let mockAllowedProfiles: string[];

const resolveAuthProfileOrderMock = vi.fn(() => mockAllowedProfiles);
const resolveAuthProfileEligibilityMock = vi.fn(() => ({
  eligible: false,
  reasonCode: "invalid_expires" as const,
}));
const resolveSecretRefStringMock = vi.fn(async () => "resolved-secret");

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => []),
}));
vi.mock("../../secrets/resolve.js", () => ({
  resolveSecretRefString: resolveSecretRefStringMock,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: () => mockStore,
    listProfilesForProvider: (_store: AuthProfileStore, provider: string) =>
      Object.entries(mockStore.profiles)
        .filter(
          ([, profile]) =>
            typeof profile.provider === "string" && profile.provider.toLowerCase() === provider,
        )
        .map(([profileId]) => profileId),
    resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
    resolveAuthProfileOrder: resolveAuthProfileOrderMock,
    resolveAuthProfileEligibility: resolveAuthProfileEligibilityMock,
  };
});

const { buildProbeTargets } = await import("./list.probe.js");

async function buildAnthropicProbePlan(order: string[]) {
  return buildProbeTargets({
    cfg: {
      auth: {
        order: {
          anthropic: order,
        },
      },
    } as OpenClawConfig,
    providers: ["anthropic"],
    modelCandidates: ["anthropic/claude-sonnet-4-6"],
    options: {
      timeoutMs: 5_000,
      concurrency: 1,
      maxTokens: 16,
    },
  });
}

async function withClearedAnthropicEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  const previousAnthropicOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  try {
    return await fn();
  } finally {
    if (previousAnthropic === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropic;
    }
    if (previousAnthropicOauth === undefined) {
      delete process.env.ANTHROPIC_OAUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_OAUTH_TOKEN = previousAnthropicOauth;
    }
  }
}

async function buildAnthropicPlanFromModelsJsonApiKey(apiKey: string) {
  return await buildProbeTargets({
    cfg: {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com/v1",
            api: "anthropic-messages",
            apiKey,
            models: [],
          },
        },
      },
    } as OpenClawConfig,
    providers: ["anthropic"],
    modelCandidates: ["anthropic/claude-sonnet-4-6"],
    options: {
      timeoutMs: 5_000,
      concurrency: 1,
      maxTokens: 16,
    },
  });
}

function expectLegacyMissingCredentialsError(
  result: { reasonCode?: string; error?: string } | undefined,
  reasonCode: string,
) {
  expect(result?.reasonCode).toBe(reasonCode);
  expect(result?.error?.split("\n")[0]).toBe("Auth profile credentials are missing or expired.");
  expect(result?.error).toContain(`[${reasonCode}]`);
}

describe("buildProbeTargets reason codes", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
          expires: 0,
        },
      },
      order: {
        anthropic: ["anthropic:default"],
      },
    };
    mockAllowedProfiles = [];
    resolveAuthProfileOrderMock.mockClear();
    resolveAuthProfileEligibilityMock.mockClear();
    resolveSecretRefStringMock.mockReset();
    resolveSecretRefStringMock.mockResolvedValue("resolved-secret");
    resolveAuthProfileEligibilityMock.mockReturnValue({
      eligible: false,
      reasonCode: "invalid_expires",
    });
  });

  it("reports invalid_expires with a legacy-compatible first error line", async () => {
    const plan = await buildAnthropicProbePlan(["anthropic:default"]);

    expect(plan.targets).toHaveLength(0);
    expect(plan.results).toHaveLength(1);
    expectLegacyMissingCredentialsError(plan.results[0], "invalid_expires");
  });

  it("reports excluded_by_auth_order when profile id is not present in explicit order", async () => {
    mockStore.order = {
      anthropic: ["anthropic:work"],
    };
    const plan = await buildAnthropicProbePlan(["anthropic:work"]);

    expect(plan.targets).toHaveLength(0);
    expect(plan.results).toHaveLength(1);
    expect(plan.results[0]?.reasonCode).toBe("excluded_by_auth_order");
    expect(plan.results[0]?.error).toBe("Excluded by auth.order for this provider.");
  });

  it("reports unresolved_ref when a ref-only profile cannot resolve its SecretRef", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "MISSING_ANTHROPIC_TOKEN" },
        },
      },
      order: {
        anthropic: ["anthropic:default"],
      },
    };
    mockAllowedProfiles = ["anthropic:default"];
    resolveSecretRefStringMock.mockRejectedValueOnce(new Error("missing secret"));

    const plan = await buildAnthropicProbePlan(["anthropic:default"]);

    expect(plan.targets).toHaveLength(0);
    expect(plan.results).toHaveLength(1);
    expectLegacyMissingCredentialsError(plan.results[0], "unresolved_ref");
    expect(plan.results[0]?.error).toContain("env:default:MISSING_ANTHROPIC_TOKEN");
  });

  it("skips marker-only models.json credentials when building probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    await withClearedAnthropicEnv(async () => {
      const plan = await buildAnthropicPlanFromModelsJsonApiKey(OLLAMA_LOCAL_AUTH_MARKER);
      expect(plan.targets).toEqual([]);
      expect(plan.results).toEqual([]);
    });
  });

  it("does not treat arbitrary all-caps models.json apiKey values as markers", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    await withClearedAnthropicEnv(async () => {
      const plan = await buildAnthropicPlanFromModelsJsonApiKey("ALLCAPS_SAMPLE");
      expect(plan.results).toEqual([]);
      expect(plan.targets).toHaveLength(1);
      expect(plan.targets[0]).toEqual(
        expect.objectContaining({
          provider: "anthropic",
          source: "models.json",
          label: "models.json",
        }),
      );
    });
  });
});
