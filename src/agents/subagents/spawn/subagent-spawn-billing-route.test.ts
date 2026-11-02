import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { registerAgentHarness } from "../../harness/registry.js";
import { describeSpawnAuth, resolveSpawnBillingRoute } from "./subagent-spawn-billing-route.js";

const storeMocks = vi.hoisted(() => ({
  fail: false,
  owner: undefined as
    | undefined
    | {
        authModes: Record<string, unknown>;
        modelCatalog?: {
          entries: { provider: string; id: string; api?: string; baseUrl?: string }[];
        };
      },
  lastRef: undefined as undefined | Record<string, unknown>,
}));

// The prepared owner is published by a running Gateway; tests supply one directly.
vi.mock("../../prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../prepared-model-catalog.js")>()),
  getPreparedModelCatalogOwnerSnapshot: () => storeMocks.owner,
  materializePreparedModelCatalogOwner: (owner: unknown) => owner,
}));
vi.mock("../../prepared-model-runtime-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../prepared-model-runtime-auth.js")>()),
  getPreparedModelRuntimeAuthStore: () =>
    storeMocks.owner ? { version: 1, profiles: {} } : undefined,
}));
// Unit workers register no CLI backends, so the CLI-runtime branch of the real evaluator is
// replaced by the decision it makes from prepared native-login facts.
vi.mock("../../model-auth-availability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../model-auth-availability.js")>();
  return {
    ...actual,
    createModelAuthAvailabilityResolver: (
      params: Parameters<typeof actual.createModelAuthAvailabilityResolver>[0],
    ) => {
      const real = actual.createModelAuthAvailabilityResolver(params);
      if (!storeMocks.owner) {
        return real;
      }
      const runtimeAuth = { id: "claude-cli", source: "native" as const };
      const mode = params.preparedRuntimeAuthModes?.["claude-cli"];
      return {
        ...real,
        evaluateRuntimeModelAuth: (_provider: string, ref: Record<string, unknown> = {}) => {
          storeMocks.lastRef = ref;
          return mode
            ? { availability: true, routeResolution: null, selectedAuthMode: "oauth", runtimeAuth }
            : {
                availability: false,
                routeResolution: null,
                unavailableReason: "missing-auth" as const,
                runtimeAuth,
              };
        },
      };
    },
  };
});

vi.mock("../../auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStoreWithoutExternalProfilesAsync: async (
      ...args: Parameters<typeof actual.ensureAuthProfileStoreWithoutExternalProfilesAsync>
    ) => {
      if (storeMocks.fail) {
        throw new Error("auth store unavailable");
      }
      return actual.ensureAuthProfileStoreWithoutExternalProfilesAsync(...args);
    },
  };
});

describe("describeSpawnAuth", () => {
  it.each([
    [
      { availability: true, selectedAuthMode: "api_key", selectedProfileId: "anthropic:default" },
      { resolvedAuth: "api-key", resolvedAuthProfile: "anthropic:default" },
    ],
    [
      { availability: true, selectedAuthMode: "oauth", selectedProfileId: "openai:chatgpt" },
      { resolvedAuth: "oauth", resolvedAuthProfile: "openai:chatgpt" },
    ],
    [
      { availability: true, selectedAuthMode: "token", selectedProfileId: "anthropic:sub" },
      { resolvedAuth: "token", resolvedAuthProfile: "anthropic:sub" },
    ],
    [
      { availability: true, runtimeAuth: { id: "claude-cli", source: "native" as const } },
      { resolvedAuth: "native" },
    ],
    [{ availability: true, selectedAuthMode: "native-command" }, { resolvedAuth: "native" }],
    [{ availability: true, selectedAuthMode: "aws-sdk" }, { resolvedAuth: "unknown" }],
    // Personal account locators stay private, matching session_status.
    [
      {
        availability: true,
        selectedAuthMode: "oauth",
        selectedProfileId:
          "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
      },
      { resolvedAuth: "oauth", resolvedAuthProfile: "personal account" },
    ],
    // A configured CLI runtime without its login must not claim the native route.
    [
      { availability: false, runtimeAuth: { id: "claude-cli", source: "native" as const } },
      { resolvedAuth: "unavailable" },
    ],
    [
      { availability: undefined, runtimeAuth: { id: "claude-cli", source: "native" as const } },
      { resolvedAuth: "unknown" },
    ],
  ])("maps %j", (evaluation, expected) => {
    expect(describeSpawnAuth(evaluation)).toEqual(expected);
  });
});

describe("resolveSpawnBillingRoute", () => {
  it("reports unknown instead of failing when the credential owner throws", async () => {
    storeMocks.fail = true;
    try {
      await expect(
        resolveSpawnBillingRoute({
          cfg: {},
          agentId: "main",
          provider: "anthropic",
          model: "claude-opus-4-6",
        }),
      ).resolves.toEqual({ resolvedRuntime: "openclaw", resolvedAuth: "unknown" });
    } finally {
      storeMocks.fail = false;
    }
  });
});

describe("resolveSpawnBillingRoute with a prepared CLI login", () => {
  const cfg = {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
      },
    },
  };
  const spawn = () =>
    resolveSpawnBillingRoute({
      cfg,
      agentId: "main",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

  it.each([
    [{ "claude-cli": { source: "native", mode: "oauth" } }, "native"],
    [{}, "unavailable"],
  ] as const)(
    "reports the CLI login from prepared facts %j as %s",
    async (authModes, resolvedAuth) => {
      storeMocks.owner = { authModes };
      try {
        await expect(spawn()).resolves.toMatchObject({
          resolvedRuntime: "claude-cli",
          resolvedAuth,
        });
      } finally {
        storeMocks.owner = undefined;
      }
    },
  );
});

describe("resolveSpawnBillingRoute with transport-dependent harness selection", () => {
  const originalRegistry = getActivePluginRegistry();
  afterEach(() => {
    storeMocks.owner = undefined;
    if (originalRegistry) {
      setActivePluginRegistry(originalRegistry, "spawn-billing-restore", "default");
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it("selects the harness from the catalog-only transport of the spawned model", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "spawn-billing-test", "default");
    registerAgentHarness({
      id: "responses-native",
      label: "Responses fixture",
      autoSelection: { providerIds: ["fixture"] },
      supports: (ctx) =>
        ctx.modelProvider?.api === "openai-responses"
          ? { supported: true, priority: 100 }
          : { supported: false },
      async runAttempt() {
        throw new Error("receipt projection must not start a turn");
      },
    });
    const spawn = () =>
      resolveSpawnBillingRoute({ cfg: {}, agentId: "main", provider: "fixture", model: "fx" });
    storeMocks.owner = { authModes: {}, modelCatalog: { entries: [] } };
    await expect(spawn()).resolves.toMatchObject({ resolvedRuntime: "openclaw" });
    // Only the published catalog knows this model's transport; config names no api.
    storeMocks.owner = {
      authModes: {},
      modelCatalog: {
        entries: [
          {
            provider: "fixture",
            id: "fx",
            api: "openai-responses",
            baseUrl: "https://fixture.invalid/v1",
          },
        ],
      },
    };
    await expect(spawn()).resolves.toMatchObject({ resolvedRuntime: "responses-native" });
    expect(storeMocks.lastRef).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://fixture.invalid/v1",
      runtimeId: "responses-native",
    });
  });
});
