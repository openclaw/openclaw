import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { createEmptyPluginSetupRegistry } from "../../../plugins/setup-registry.test-support.js";
import {
  createClaudeCliBackends,
  testing as cliBackendsTesting,
} from "../../cli-backends.test-support.js";
import { registerAgentHarness } from "../../harness/registry.js";
import {
  dualRoutes,
  mockRouteResolverFactory,
  routeResolverFactory,
} from "../../model-auth-availability.test-support.js";
import {
  harnessRegistry,
  row,
  snapshot as catalogSnapshot,
} from "../../model-catalog-fixtures.test-support.js";
import type { ModelCatalogEntry } from "../../model-catalog.types.js";
import { markPreparedModelCatalogFull } from "../../prepared-model-runtime.full-catalog.js";
import { describeSpawnAuth, resolveSpawnBillingRoute } from "./subagent-spawn-billing-route.js";

const storeMocks = vi.hoisted(() => ({ fail: false, owner: undefined as unknown }));

// A running Gateway publishes the prepared owner; tests supply one built from catalog fixtures.
// Credential evaluation then runs through the real decision owner and evaluator.
vi.mock("../../prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../prepared-model-catalog.js")>()),
  getPreparedModelCatalogOwnerSnapshot: () => storeMocks.owner,
  materializePreparedModelCatalogOwner: (owner: unknown) => owner,
}));
vi.mock("../../prepared-model-runtime-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../prepared-model-runtime-auth.js")>()),
  getPreparedModelRuntimeAuthStore: () =>
    storeMocks.owner ? { version: 1, profiles: {} } : undefined,
  getPreparedModelRuntimeAuthMaterializations: () => [],
}));

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
    // A runtime login that names its credential kind reports that kind, like session_status.
    [
      {
        availability: true,
        selectedAuthMode: "api_key",
        runtimeAuth: { id: "codex", source: "native" as const },
      },
      { resolvedAuth: "api-key" },
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

  it("keeps a CLI backend's own login native, like session_status", () => {
    expect(
      describeSpawnAuth(
        {
          availability: true,
          selectedAuthMode: "oauth",
          runtimeAuth: { id: "claude-cli", source: "native" },
        },
        { cliBackend: true },
      ),
    ).toEqual({ resolvedAuth: "native" });
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

function preparedOwner(params: {
  config: OpenClawConfig;
  entries: ModelCatalogEntry[];
  authModes: Record<string, unknown>;
  metadataSnapshot?: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
}) {
  return {
    config: params.config,
    agentDir: "/tmp/spawn-billing-agent",
    workspaceDir: "/tmp/spawn-billing-workspace",
    // A complete published catalog: native readiness for every configured runtime was probed.
    modelCatalog: markPreparedModelCatalogFull(catalogSnapshot(params.entries)),
    metadataSnapshot:
      params.metadataSnapshot ?? createPluginMetadataSnapshotFixture({ plugins: [] }),
    authModes: params.authModes,
    pluginRegistry: params.pluginRegistry,
    isCurrent: () => true,
  };
}

const originalRegistry = getActivePluginRegistry();
function restoreRegistry() {
  storeMocks.owner = undefined;
  if (originalRegistry) {
    setActivePluginRegistry(originalRegistry, "spawn-billing-restore", "default");
  } else {
    resetPluginRuntimeStateForTest();
  }
}

describe("resolveSpawnBillingRoute with a prepared Codex login", () => {
  const config: OpenClawConfig = {
    plugins: { entries: { codex: { enabled: true } } },
    agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } } },
  };
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", ""));
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreRegistry();
  });

  it.each([
    [{ codex: { source: "native", mode: "api_key" } }, "api-key"],
    [{ codex: { source: "native", mode: "oauth" } }, "oauth"],
    [{}, "unavailable"],
  ] as const)(
    "reports a registered Codex harness login %j as %s",
    async (authModes, resolvedAuth) => {
      const registry = harnessRegistry("codex");
      setActivePluginRegistry(registry, "spawn-billing-codex", "default");
      mockRouteResolverFactory(routeResolverFactory(dualRoutes));
      storeMocks.owner = preparedOwner({
        config,
        entries: [row("openai", "gpt-5.4")],
        authModes,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
        }),
        pluginRegistry: registry,
      });
      await expect(
        resolveSpawnBillingRoute({
          cfg: config,
          agentId: "main",
          provider: "openai",
          model: "gpt-5.4",
        }),
      ).resolves.toEqual({ resolvedRuntime: "codex", resolvedAuth });
    },
  );
});

describe("resolveSpawnBillingRoute with a prepared Claude CLI login", () => {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        models: { "anthropic/claude-haiku-4-5": { agentRuntime: { id: "claude-cli" } } },
      },
    },
  };
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => createEmptyPluginSetupRegistry(),
      resolveRuntimeCliBackends: createClaudeCliBackends,
    });
  });
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    vi.unstubAllEnvs();
    restoreRegistry();
  });

  it.each([
    [{ "claude-cli": { source: "native", mode: "oauth" } }, "native"],
    [{}, "unavailable"],
  ] as const)("reports the Claude CLI login %j as %s", async (authModes, resolvedAuth) => {
    storeMocks.owner = preparedOwner({
      config,
      entries: [],
      authModes,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [{ id: "anthropic", providers: ["anthropic"], cliBackends: ["claude-cli"] }],
      }),
    });
    await expect(
      resolveSpawnBillingRoute({
        cfg: config,
        agentId: "main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    ).resolves.toEqual({ resolvedRuntime: "claude-cli", resolvedAuth });
  });

  it("reports unknown, not unavailable, before prepared facts are published", async () => {
    // Without the prepared owner the CLI's own login is invisible to the evaluator.
    await expect(
      resolveSpawnBillingRoute({
        cfg: config,
        agentId: "main",
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    ).resolves.toEqual({ resolvedRuntime: "claude-cli", resolvedAuth: "unknown" });
  });
});

describe("resolveSpawnBillingRoute with transport-dependent harness selection", () => {
  afterEach(restoreRegistry);

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
    storeMocks.owner = preparedOwner({ config: {}, entries: [], authModes: {} });
    await expect(spawn()).resolves.toMatchObject({ resolvedRuntime: "openclaw" });
    // Only the published catalog knows this model's transport; config names no api.
    storeMocks.owner = preparedOwner({
      config: {},
      entries: [
        row("fixture", "fx", { api: "openai-responses", baseUrl: "https://fixture.invalid/v1" }),
      ],
      authModes: {},
    });
    await expect(spawn()).resolves.toMatchObject({ resolvedRuntime: "responses-native" });
  });
});
