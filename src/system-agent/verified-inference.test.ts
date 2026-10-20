import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as authStore from "../agents/auth-profiles/store-runtime.js";
import * as cliAuthEpoch from "../agents/cli-auth-epoch.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import type { AgentHarnessAuthBindingFingerprintParams } from "../agents/harness/types.js";
import * as modelAuth from "../agents/model-auth.js";
import * as configModule from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginArtifactIdentity from "../plugins/plugin-runtime-artifact-identity.js";
import { createInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { createInferenceConfigFixture } from "./inference-config.test-support.js";
import { resolveSystemAgentConfiguredRouteFromConfig as resolveSystemAgentConfiguredRouteFromConfigImpl } from "./inference-route.js";
import { resolvePersistentApplyInference as resolvePersistentApplyInferenceImpl } from "./setup-inference.js";
import {
  installSystemAgentClaudeCliBackendTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import {
  createSystemAgentVerifiedInferenceBinding as createSystemAgentVerifiedInferenceBindingImpl,
  resolveSystemAgentVerifiedInferenceRoute as resolveSystemAgentVerifiedInferenceRouteImpl,
} from "./verified-inference.js";
import {
  config,
  profileAuth,
  profileStore,
  requireFingerprint,
  cliRuntimeArtifactAuth,
  codexRuntimeArtifactAuth,
  pluginRecord,
} from "./verified-inference.test-support.js";

const pluginRegistryState = vi.hoisted(() => ({
  providerOwnerIds: ["provider-owner"],
  records: [] as Array<ReturnType<typeof pluginRecord>>,
}));
const harnessRuntimeArtifactState = vi.hoisted(() => ({
  id: "codex-app-server",
  fingerprint: "codex-runtime-v1",
  valid: true,
  ownsAuthBootstrap: true,
  acceptUnknown: false,
  authFingerprint:
    vi.fn<
      (
        params: AgentHarnessAuthBindingFingerprintParams & { harnessId: string },
      ) => Promise<string | undefined>
    >(),
}));

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => [...pluginRegistryState.providerOwnerIds]),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => [...pluginRegistryState.providerOwnerIds]),
}));

vi.mock("../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

vi.mock("../agents/harness/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/registry.js")>()),
  getRegisteredAgentHarness: vi.fn((id: string) =>
    id === "codex" || harnessRuntimeArtifactState.acceptUnknown
      ? {
          harness: {
            ...(harnessRuntimeArtifactState.ownsAuthBootstrap
              ? { authBootstrap: "harness" as const }
              : {}),
            runtimeArtifact: {
              validate: async (artifact: { id: string; fingerprint: string }) =>
                harnessRuntimeArtifactState.acceptUnknown ||
                (harnessRuntimeArtifactState.valid &&
                  artifact.id === harnessRuntimeArtifactState.id &&
                  artifact.fingerprint === harnessRuntimeArtifactState.fingerprint),
            },
            authBinding: { fingerprint: harnessRuntimeArtifactState.authFingerprint },
          },
        }
      : undefined,
  ),
}));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshot: vi.fn(() =>
    createInstalledPluginIndex({ plugins: pluginRegistryState.records }),
  ),
}));

const profile = {
  type: "api_key" as const,
  provider: "openai",
  key: "verified-key",
};

const runtime = { log: () => {}, error: () => {}, exit: () => {} } as never;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

const resolveSystemAgentConfiguredRouteFromConfig: typeof resolveSystemAgentConfiguredRouteFromConfigImpl =
  (...args) =>
    pluginMetadataSnapshot!.run(
      () => resolveSystemAgentConfiguredRouteFromConfigImpl(...args),
      args[0],
    );

const resolvePersistentApplyInference: typeof resolvePersistentApplyInferenceImpl = (...args) =>
  pluginMetadataSnapshot!.run(() => resolvePersistentApplyInferenceImpl(...args));

const createSystemAgentVerifiedInferenceBinding: typeof createSystemAgentVerifiedInferenceBindingImpl =
  (...args) =>
    pluginMetadataSnapshot!.run(() => createSystemAgentVerifiedInferenceBindingImpl(...args));

const resolveSystemAgentVerifiedInferenceRoute: typeof resolveSystemAgentVerifiedInferenceRouteImpl =
  (...args) =>
    pluginMetadataSnapshot!.run(() => resolveSystemAgentVerifiedInferenceRouteImpl(...args));
let restoreCliBackendFixture: (() => void) | undefined;

beforeAll(() => {
  pluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot(config());
  restoreCliBackendFixture = installSystemAgentClaudeCliBackendTestFixture();
});

afterAll(() => {
  restoreCliBackendFixture?.();
});

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  pluginRegistryState.providerOwnerIds = ["provider-owner"];
  pluginRegistryState.records = [pluginRecord("provider-owner"), pluginRecord("codex")];
  harnessRuntimeArtifactState.id = "codex-app-server";
  harnessRuntimeArtifactState.fingerprint = "codex-runtime-v1";
  harnessRuntimeArtifactState.valid = true;
  harnessRuntimeArtifactState.ownsAuthBootstrap = true;
  harnessRuntimeArtifactState.acceptUnknown = false;
  mockAuth();
  vi.spyOn(cliAuthEpoch, "resolveCliRuntimeArtifactFingerprint").mockResolvedValue(
    "claude-cli-artifact-v1",
  );
  vi.spyOn(pluginArtifactIdentity, "fingerprintPluginRuntimeArtifact").mockImplementation(
    (record) => `${record.pluginId}-runtime-v1`,
  );
  vi.spyOn(pluginArtifactIdentity, "loadPluginRuntimeArtifactIdentitySources").mockImplementation(
    () => pluginRegistryState.records,
  );
});

function mockAuth(apiKey = "verified-key") {
  const resolvedAuth = profileAuth("openai:verified", apiKey);
  vi.spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync").mockImplementation(
    profileStore("openai:verified", {
      ...profile,
      key: apiKey,
    }),
  );
  vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockResolvedValue(resolvedAuth);
  harnessRuntimeArtifactState.authFingerprint.mockImplementation(async (params) => {
    const credential = params.authProfileStore.profiles[params.authProfileId];
    return credential
      ? fingerprintResolvedAuthProfileCredential({
          profileId: params.authProfileId,
          credential,
          resolvedAuth: profileAuth(params.authProfileId, apiKey),
        })
      : undefined;
  });
}

async function bindingFor(baseConfig: OpenClawConfig, preparedRoute?: ConfiguredRoute) {
  const route = preparedRoute ?? (await requireRoute(baseConfig));
  const authFingerprint = requireFingerprint(
    fingerprintAuthProfileCredential({ profileId: "openai:verified", credential: profile }),
  );
  const agentHarnessId =
    route.runner === "embedded"
      ? route.agentHarnessRuntimeOverride === "auto"
        ? "openclaw"
        : (route.agentHarnessRuntimeOverride ?? "codex")
      : undefined;
  return createBinding(route, {
    authProfileId: "openai:verified",
    authFingerprint,
    modelId: route.model,
    modelApi: route.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
    ...(agentHarnessId
      ? {
          agentHarnessId,
          ...(agentHarnessId === "openclaw"
            ? {}
            : {
                runtimeOwnerKind: "plugin-harness" as const,
                runtimeOwnerId: agentHarnessId,
                ...codexRuntimeArtifactAuth,
              }),
        }
      : {}),
  });
}

type ConfiguredRoute = NonNullable<
  Awaited<ReturnType<typeof resolveSystemAgentConfiguredRouteFromConfig>>
>;
type EmbeddedRoute = Extract<ConfiguredRoute, { runner: "embedded" }>;
type CliRoute = Extract<ConfiguredRoute, { runner: "cli" }>;

async function requireRoute(baseConfig: OpenClawConfig): Promise<ConfiguredRoute>;
async function requireRoute(baseConfig: OpenClawConfig, runner: "embedded"): Promise<EmbeddedRoute>;
async function requireRoute(baseConfig: OpenClawConfig, runner: "cli"): Promise<CliRoute>;
async function requireRoute(baseConfig: OpenClawConfig, runner?: ConfiguredRoute["runner"]) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(baseConfig);
  if (!route || (runner && route.runner !== runner)) {
    throw new Error("missing test route");
  }
  return route;
}

function createBinding(
  route: ConfiguredRoute,
  auth: Parameters<typeof createSystemAgentVerifiedInferenceBinding>[0]["auth"],
) {
  return createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth,
  });
}

function configSnapshot(baseConfig: OpenClawConfig) {
  const snapshot = { exists: true, valid: true, config: baseConfig };
  return { readConfigFileSnapshot: vi.fn(async () => snapshot) as never };
}

function codexHarnessConfig(
  profileId?: string,
  plugins?: OpenClawConfig["plugins"],
): OpenClawConfig {
  return {
    agents: {
      entries: {
        ops: {
          model: `openai/gpt-5.5${profileId ? `@${profileId}` : ""}`,
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
        },
      },
    },
    ...(profileId
      ? { auth: { profiles: { [profileId]: { provider: "openai", mode: "api_key" } } } }
      : {}),
    ...(plugins ? { plugins } : {}),
  };
}

function opaqueHarnessAuth(route: ConfiguredRoute, backendId = "codex") {
  const runtimeOwnerFingerprint = requireFingerprint(
    fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: route.provider,
      backendId,
      runtimeArtifactFingerprint: codexRuntimeArtifactAuth.runtimeArtifactFingerprint,
    }),
  );
  return {
    agentHarnessId: backendId,
    runtimeOwnerFingerprint,
    runtimeOwnerKind: "plugin-harness" as const,
    runtimeOwnerId: backendId,
    ...codexRuntimeArtifactAuth,
  };
}

async function opaqueHarnessBinding(
  baseConfig: OpenClawConfig,
  options: { configuredAuto?: boolean; backendId?: string } = {},
) {
  const route = await requireRoute(baseConfig, "embedded");
  const configuredRoute = options.configuredAuto
    ? ({ ...route, agentHarnessRuntimeOverride: "auto" } satisfies ConfiguredRoute)
    : route;
  const binding = await createBinding(
    configuredRoute,
    opaqueHarnessAuth(configuredRoute, options.backendId),
  );
  return { binding };
}

async function revalidate(
  binding: Awaited<ReturnType<typeof bindingFor>>,
  baseConfig: OpenClawConfig,
) {
  return resolveSystemAgentVerifiedInferenceRoute(binding, {
    ...configSnapshot(baseConfig),
  });
}

async function envAuthFixture() {
  const baseConfig = {
    agents: {
      defaults: {
        model: "openai/gpt-5.6",
        models: { "openai/gpt-5.6": { agentRuntime: { id: "openclaw" } } },
      },
    },
  } satisfies OpenClawConfig;
  const route = await requireRoute(baseConfig);
  const resolvedAuth = {
    apiKey: "env-key",
    source: "env: OPENAI_API_KEY",
    mode: "api-key" as const,
  };
  return {
    route,
    authFingerprint: requireFingerprint(fingerprintResolvedProviderAuth(resolvedAuth)),
    resolveAuth: vi.fn(async () => resolvedAuth),
  };
}

describe("verified OpenClaw inference binding", () => {
  it("invalidates an identity-less OAuth binding when its grant changes", async () => {
    const oauthConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8@anthropic:oauth" } },
      auth: { profiles: { "anthropic:oauth": { provider: "anthropic", mode: "oauth" } } },
    } satisfies OpenClawConfig;
    const route = await requireRoute(oauthConfig);
    const credential = {
      type: "oauth" as const,
      provider: "anthropic",
      access: "access-a",
      refresh: "refresh-a",
      expires: 1,
    };
    const authFingerprint = requireFingerprint(
      fingerprintAuthProfileCredential({ profileId: "anthropic:oauth", credential }),
    );
    vi.spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync").mockImplementation(
      profileStore("anthropic:oauth", credential),
    );
    const binding = await createBinding(route, {
      authProfileId: "anthropic:oauth",
      authFingerprint,
      agentHarnessId: "openclaw",
    });

    vi.spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync").mockImplementation(
      profileStore("anthropic:oauth", {
        ...credential,
        access: "access-b",
        refresh: "refresh-b",
      }),
    );
    const current = await revalidate(binding, oauthConfig);

    expect(current).toBeNull();
  });

  it("rejects a binding when no credential fingerprint can be observed", async () => {
    const route = await requireRoute(config());
    vi.spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync").mockImplementation(
      profileStore("openai:verified", {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "file", provider: "vault", id: "/openai/key" },
      }),
    );
    harnessRuntimeArtifactState.authFingerprint.mockRejectedValue(
      new Error("active secret unavailable"),
    );

    await expect(
      createBinding(route, {
        authProfileId: "openai:verified",
        authFingerprint: "reported-owner",
        agentHarnessId: "codex",
        runtimeOwnerKind: "plugin-harness",
        runtimeOwnerId: "codex",
        ...codexRuntimeArtifactAuth,
      }),
    ).rejects.toThrow("active secret unavailable");
  });

  it("reuses the successful model transport facts for owner re-resolution", async () => {
    // The successful run already resolved the model under its selected auth
    // plan. Revalidation must carry that exact tuple forward instead of
    // repeating catalog and provider discovery in the authority hot path.
    const { route, authFingerprint, resolveAuth } = await envAuthFixture();
    vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockImplementation(resolveAuth);
    const binding = await createBinding(route, {
      authFingerprint,
      agentHarnessId: "openclaw",
      modelId: "gpt-5.6",
      modelApi: "openai-responses",
    });

    expect(binding.auth.authFingerprint).toBe(authFingerprint);
    expect(resolveAuth).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gpt-5.6", modelApi: "openai-responses" }),
    );
  });

  it("fails closed when a credential-backed run omits its model transport facts", async () => {
    const { route, authFingerprint, resolveAuth } = await envAuthFixture();
    vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockImplementation(resolveAuth);

    await expect(
      createBinding(route, { authFingerprint, agentHarnessId: "openclaw" }),
    ).rejects.toThrow("no longer the active route owner");
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it("accepts and revalidates an opaque CLI owner emitted after a successful turn", async () => {
    const cliConfig = {
      agents: {
        entries: { ops: { model: "claude-cli/claude-opus-5" } },
      },
    } satisfies OpenClawConfig;
    const route = await requireRoute(cliConfig, "cli");
    const resolveOwner = vi.fn(async () => "opaque-cli-owner");
    vi.spyOn(cliAuthEpoch, "resolveCliRuntimeOwnerFingerprint").mockImplementation(resolveOwner);
    const binding = await createBinding(route, {
      runtimeOwnerFingerprint: "opaque-cli-owner",
      runtimeOwnerKind: "cli-runtime",
      runtimeOwnerId: "claude-cli",
      ...cliRuntimeArtifactAuth,
    });

    expect(binding.auth).toMatchObject({
      authFingerprint: "opaque-cli-owner",
      proofKind: "runtime-owner",
    });
    expect(resolveOwner).toHaveBeenCalledWith(expect.objectContaining({ agentId: "ops" }));
    await expect(revalidate(binding, cliConfig)).resolves.toBe(binding.execution);

    resolveOwner.mockResolvedValue("replacement-owner");
    await expect(revalidate(binding, cliConfig)).resolves.toBeNull();
  });

  it("invalidates a strict CLI credential when its package artifact changes", async () => {
    const cliConfig = {
      agents: { defaults: { model: "claude-cli/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const route = await requireRoute(cliConfig, "cli");
    const resolveAuth = vi.fn(async () => "strict-cli-credential");
    const resolveArtifact = vi.fn(async () => "claude-cli-artifact-v1");
    vi.spyOn(cliAuthEpoch, "resolveCliAuthBindingFingerprint").mockImplementation(resolveAuth);
    vi.spyOn(cliAuthEpoch, "resolveCliRuntimeArtifactFingerprint").mockImplementation(
      resolveArtifact,
    );
    const binding = await createBinding(route, {
      authFingerprint: "strict-cli-credential",
      ...cliRuntimeArtifactAuth,
    });

    resolveArtifact.mockResolvedValue("claude-cli-artifact-v2");
    await expect(revalidate(binding, cliConfig)).resolves.toBeNull();
  });

  it.each(["cli", "embedded"] as const)(
    "keeps a verified %s owner when first-agent setup materializes the same credential directory",
    async (runner) => {
      const baseConfig = config(
        runner === "cli" ? "claude-cli/claude-opus-5" : "openai/gpt-5.5@openai:verified",
      );
      baseConfig.agents = { ...baseConfig.agents, entries: { main: {} } };
      vi.spyOn(cliAuthEpoch, "resolveCliRuntimeOwnerFingerprint").mockResolvedValue(
        "opaque-cli-owner",
      );
      const binding =
        runner === "cli"
          ? await createBinding(await requireRoute(baseConfig, "cli"), {
              runtimeOwnerFingerprint: "opaque-cli-owner",
              runtimeOwnerKind: "cli-runtime",
              runtimeOwnerId: "claude-cli",
              ...cliRuntimeArtifactAuth,
            })
          : await bindingFor(baseConfig);
      const materialized = {
        ...baseConfig,
        agents: {
          ...baseConfig.agents,
          entries: {
            main: {
              name: "main",
              workspace: "/tmp/first-run-workspace",
              agentDir: binding.execution.agentDir,
            },
          },
        },
      } satisfies OpenClawConfig;

      await expect(revalidate(binding, materialized)).resolves.toBe(binding.execution);

      const moved = structuredClone(materialized);
      moved.agents.entries.main.agentDir = path.join(binding.execution.agentDir, "replacement");
      await expect(revalidate(binding, moved)).resolves.toBeNull();

      vi.mocked(cliAuthEpoch.resolveCliRuntimeArtifactFingerprint).mockResolvedValue(
        "replacement-cli-artifact",
      );
      harnessRuntimeArtifactState.fingerprint = "replacement-harness-artifact";
      await expect(revalidate(binding, materialized)).resolves.toBeNull();
    },
  );

  it("invalidates a strict CLI binding when its forwarded SecretRef changes", async () => {
    const profileId = "claude-cli:work";
    const cliConfig = {
      agents: {
        entries: {
          ops: {
            model: `claude-cli/claude-opus-4-8@${profileId}`,
          },
        },
      },
      auth: { profiles: { [profileId]: { provider: "claude-cli", mode: "api_key" } } },
    } satisfies OpenClawConfig;
    const credential = {
      type: "api_key" as const,
      provider: "claude-cli",
      keyRef: { source: "file" as const, provider: "vault", id: "/claude/work" },
    };
    const ensureStore = profileStore(profileId, credential);
    vi.spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync").mockImplementation(ensureStore);
    const route = await resolveSystemAgentConfiguredRouteFromConfig(cliConfig);
    if (!route || route.runner !== "cli" || route.authProfileId !== profileId) {
      throw new Error("missing test CLI SecretRef route");
    }
    let activeKey = "materialized-a";
    const resolveAuth = vi.fn(async () => profileAuth(profileId, activeKey));
    const resolveBinding = vi.fn(
      async (params: { resolvedAuth?: { apiKey?: string } }) =>
        params.resolvedAuth?.apiKey && `strict:${params.resolvedAuth.apiKey}`,
    );
    vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockImplementation(resolveAuth);
    vi.spyOn(cliAuthEpoch, "resolveCliAuthBindingFingerprint").mockImplementation(resolveBinding);
    const binding = await createBinding(route, {
      authProfileId: profileId,
      authFingerprint: "strict:materialized-a",
      ...cliRuntimeArtifactAuth,
    });

    expect(resolveBinding).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolvedAuth: expect.objectContaining({ apiKey: "materialized-a", profileId }),
      }),
    );
    expect(resolveAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId, lockedProfile: true, secretSentinels: false }),
    );
    activeKey = "materialized-b";
    await expect(revalidate(binding, cliConfig)).resolves.toBeNull();
    expect(resolveBinding).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolvedAuth: expect.objectContaining({ apiKey: "materialized-b", profileId }),
      }),
    );
    expect(resolveAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId, lockedProfile: true, secretSentinels: false }),
    );
  });

  it("requires a child runtime artifact for credential-backed plugin harness inference", async () => {
    const harnessConfig = codexHarnessConfig("openai:verified");
    const route = await requireRoute(harnessConfig, "embedded");
    const authFingerprint = requireFingerprint(
      fingerprintAuthProfileCredential({ profileId: "openai:verified", credential: profile }),
    );
    const harnessAuth = {
      authProfileId: "openai:verified",
      authFingerprint,
      agentHarnessId: "codex",
      runtimeOwnerKind: "plugin-harness" as const,
      runtimeOwnerId: "codex",
    };

    await expect(
      createBinding(route, { authProfileId: "openai:verified", authFingerprint }),
    ).rejects.toThrow("did not report its exact runtime artifact");

    await expect(createBinding(route, harnessAuth)).rejects.toThrow(
      "did not report its exact runtime artifact",
    );

    await expect(
      createBinding(route, { ...harnessAuth, ...codexRuntimeArtifactAuth }),
    ).resolves.toMatchObject({
      execution: { agentHarnessRuntimeOverride: "codex" },
      auth: { authFingerprint, runtimeArtifactFingerprint: "codex-runtime-v1" },
    });
  });

  it("freezes auto to the successful built-in harness", async () => {
    const harnessConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5@openai:verified",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
      auth: {
        profiles: { "openai:verified": { provider: "openai", mode: "api_key" } },
      },
    } satisfies OpenClawConfig;
    const resolved = await requireRoute(harnessConfig, "embedded");
    const configuredRoute = {
      ...resolved,
      agentHarnessRuntimeOverride: "auto",
    } satisfies typeof resolved;
    const authFingerprint = requireFingerprint(
      fingerprintResolvedProviderAuth(profileAuth("openai:verified", "verified-key")),
    );

    await expect(
      createBinding(configuredRoute, { authProfileId: "openai:verified", authFingerprint }),
    ).rejects.toThrow("did not report its exact agent harness");

    const binding = await createBinding(configuredRoute, {
      authProfileId: "openai:verified",
      authFingerprint,
      agentHarnessId: "openclaw",
      modelId: configuredRoute.model,
      modelApi: "openai-responses",
    });

    expect(binding.execution).toMatchObject({ agentHarnessRuntimeOverride: "openclaw" });
    expect(binding.auth.agentHarnessId).toBe("openclaw");
  });

  it("rejects an opaque harness with no trusted manifest owner", async () => {
    const resolved = await requireRoute(codexHarnessConfig(), "embedded");
    const configuredRoute = {
      ...resolved,
      agentHarnessRuntimeOverride: "auto",
    } satisfies typeof resolved;
    harnessRuntimeArtifactState.acceptUnknown = true;

    await expect(
      createBinding(configuredRoute, opaqueHarnessAuth(configuredRoute, "unowned-harness")),
    ).rejects.toThrow("no trusted manifest owner");
  });

  it("invalidates a plugin-harness owner when its manifest-owned config drifts", async () => {
    const harnessConfig = codexHarnessConfig(undefined, {
      entries: { codex: { config: { appServer: { command: "codex" } } } },
    });
    const { binding } = await opaqueHarnessBinding(harnessConfig);
    const changed = structuredClone(harnessConfig);
    changed.plugins!.entries!.codex!.config = { appServer: { command: "/opt/other/codex" } };

    await expect(revalidate(binding, changed)).resolves.toBeNull();
  });

  it("keeps core-bootstrap plugin harnesses on exact raw-profile revalidation", async () => {
    harnessRuntimeArtifactState.ownsAuthBootstrap = false;
    const harnessConfig = codexHarnessConfig("openai:verified");
    const route = await requireRoute(harnessConfig, "embedded");
    const resolvedAuth = profileAuth("openai:verified", "verified-key");
    const authFingerprint = requireFingerprint(
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:verified",
        credential: profile,
        resolvedAuth,
      }),
    );
    const resolveAuth = vi.fn(async () => resolvedAuth);
    vi.spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync").mockImplementation(
      profileStore("openai:verified", profile),
    );
    vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockImplementation(resolveAuth);
    const binding = await createBinding(route, {
      authProfileId: "openai:verified",
      authFingerprint,
      agentHarnessId: "codex",
      modelId: route.model,
      modelApi: "openai-responses",
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
      ...codexRuntimeArtifactAuth,
    });

    await expect(revalidate(binding, harnessConfig)).resolves.toBe(binding.execution);
    expect(resolveAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileId: "openai:verified",
        lockedProfile: true,
        secretSentinels: false,
      }),
    );
  });

  it("invalidates a plugin-harness binding when its forwarded SecretRef changes", async () => {
    const harnessConfig = codexHarnessConfig("openai:work");
    const route = await requireRoute(harnessConfig, "embedded");
    if (route.authProfileId !== "openai:work") {
      throw new Error("missing test plugin harness profile route");
    }
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      keyRef: { source: "env" as const, provider: "default", id: "OPENAI_WORK_KEY" },
    };
    let activeKey = "work-key";
    const resolveHarnessAuth = vi.fn(async () =>
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:work",
        credential,
        resolvedAuth: profileAuth("openai:work", activeKey),
      }),
    );
    const authFingerprint = requireFingerprint(
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:work",
        credential,
        resolvedAuth: profileAuth("openai:work", activeKey),
      }),
    );
    vi.spyOn(authStore, "loadAuthProfileStoreForRuntimeAsync").mockImplementation(
      profileStore("openai:work", credential),
    );
    harnessRuntimeArtifactState.authFingerprint.mockImplementation(resolveHarnessAuth);
    const binding = await createBinding(route, {
      authProfileId: "openai:work",
      authFingerprint,
      agentHarnessId: "codex",
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
      ...codexRuntimeArtifactAuth,
    });

    await expect(revalidate(binding, harnessConfig)).resolves.toBe(binding.execution);

    activeKey = "replacement-key";
    await expect(revalidate(binding, harnessConfig)).resolves.toBeNull();
    expect(resolveHarnessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ harnessId: "codex", authProfileId: "openai:work" }),
    );
  });

  it("refuses to mint an AWS SDK owner without exact principal proof", async () => {
    const bedrockConfig = {
      agents: {
        defaults: { model: "amazon-bedrock/us.anthropic.claude-sonnet-4-6" },
      },
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            api: "bedrock-converse-stream",
            auth: "aws-sdk",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const route = await requireRoute(bedrockConfig, "embedded");
    const auth = { source: "aws-sdk default chain", mode: "aws-sdk" as const };
    const fingerprint = () =>
      fingerprintAwsSdkRuntimeOwner({
        provider: route.provider,
        backendId: route.agentHarnessRuntimeOverride ?? "openclaw",
        auth,
      });
    try {
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_SESSION_TOKEN", "");
      vi.stubEnv("AWS_PROFILE", "work");
      expect(fingerprint()).toBeUndefined();

      vi.stubEnv("AWS_PROFILE", "");
      expect(fingerprint()).toBeUndefined();

      await expect(createBinding(route, {})).rejects.toThrow(
        "did not report one exact execution owner",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([{ name: "an owner is removed", ownerIds: [] as string[], records: [] }])(
    "invalidates a strict credential when $name",
    async ({ ownerIds, records }) => {
      const baseConfig = config();
      const binding = await bindingFor(baseConfig);
      pluginRegistryState.providerOwnerIds = ownerIds;
      pluginRegistryState.records = records;

      const route = await revalidate(binding, baseConfig);

      expect(route).toBeNull();
    },
  );

  it("invalidates a strict credential when its owning runtime is removed", async () => {
    const baseConfig = config();
    const binding = await bindingFor(baseConfig);
    pluginRegistryState.records = [];

    const route = await revalidate(binding, baseConfig);

    expect(route).toBeNull();
  });

  it.each([
    {
      name: "path/dev executable",
      origin: "config" as const,
      sourcePath: "src/index.ts",
      installRecordHash: undefined,
    },
  ])(
    "invalidates a strict credential after an in-place $name change with stable registry identity",
    async ({ origin, sourcePath, installRecordHash }) => {
      vi.mocked(pluginArtifactIdentity.fingerprintPluginRuntimeArtifact).mockRestore();
      const runtimePath = "dist/index.js";
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openclaw-plugin-"));
      try {
        const rootDir = path.join(tempDir, "provider-owner");
        const source = path.join(rootDir, sourcePath);
        const manifestPath = path.join(rootDir, "openclaw.plugin.json");
        const packageJsonPath = path.join(rootDir, "package.json");
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, "export const sourceRevision = 1;\n", "utf8");
        const runtimeSource = path.join(rootDir, runtimePath);
        fs.mkdirSync(path.dirname(runtimeSource), { recursive: true });
        fs.writeFileSync(runtimeSource, "export const runtimeRevision = 1;\n", "utf8");
        fs.writeFileSync(manifestPath, '{"id":"provider-owner"}\n', "utf8");
        fs.writeFileSync(packageJsonPath, '{"name":"@openclaw/provider-owner"}\n', "utf8");

        const record = pluginRecord("provider-owner", {
          origin,
          rootDir,
          manifestPath,
          source,
          installRecordHash,
          packageJson: { path: packageJsonPath, hash: "provider-owner-package-v1" },
        });
        const codexRootDir = path.join(tempDir, "codex");
        const codexSource = path.join(codexRootDir, "index.js");
        const codexManifestPath = path.join(codexRootDir, "openclaw.plugin.json");
        const codexPackageJsonPath = path.join(codexRootDir, "package.json");
        fs.mkdirSync(codexRootDir, { recursive: true });
        fs.writeFileSync(codexSource, "export const runtime = 'codex';\n", "utf8");
        fs.writeFileSync(codexManifestPath, '{"id":"codex"}\n', "utf8");
        fs.writeFileSync(codexPackageJsonPath, '{"name":"@openclaw/codex"}\n', "utf8");
        const codexRecord = pluginRecord("codex", {
          rootDir: codexRootDir,
          manifestPath: codexManifestPath,
          source: codexSource,
          packageJson: { path: codexPackageJsonPath, hash: "codex-package-v1" },
        });
        pluginRegistryState.records = [record, codexRecord];
        const baseConfig = config();
        const configFixture = await createInferenceConfigFixture(baseConfig);
        const snapshot = configFixture.snapshot;
        const view = snapshot.runtimeConfig ?? snapshot.config;
        const route = await resolveSystemAgentConfiguredRouteFromConfig(
          view,
          undefined,
          {},
          snapshot,
        );
        if (!route) {
          throw new Error("missing physical-artifact test route");
        }
        const binding = await bindingFor(view, route);
        vi.spyOn(configModule, "readConfigFileSnapshot").mockImplementation(configFixture.read);

        await expect(
          resolvePersistentApplyInference({
            binding,
            runtime,
          }),
        ).resolves.toBe(binding.execution);

        fs.writeFileSync(runtimeSource, "export const runtimeRevision = 2;\n", "utf8");

        await expect(
          resolvePersistentApplyInference({
            binding,
            runtime,
          }),
        ).resolves.toBeNull();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      name: "plugins.allow excludes the owner",
      plugins: { allow: ["discord"] },
      remainsValid: false,
    },
  ])("projects the provider-owner policy when $name", async ({ plugins, remainsValid }) => {
    const baseConfig = { ...config(), plugins: { allow: [] } } satisfies OpenClawConfig;
    const binding = await bindingFor(baseConfig);
    const changed = { ...config(), plugins } satisfies OpenClawConfig;

    const route = await revalidate(binding, changed);

    expect(route).toBe(remainsValid ? binding.execution : null);
  });
});
