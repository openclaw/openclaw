import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  AuthProfileMigrationRequiredError,
  clearAuthProfileMigrationDiagnostics,
  markAuthProfileMigrationRequired,
} from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { runEmbeddedAgent as runEmbeddedAgentOwner } from "../agents/embedded-agent.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "../agents/model-auth-runtime-config.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import { readConfigFileSnapshot } from "../config/config.js";
import * as configModule from "../config/config.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { looksLikeSecretSentinel } from "../secrets/sentinel.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import {
  completeSetupInference,
  verifySetupInference,
  verifySetupInferenceConfig,
} from "./setup-inference-turn.js";
import * as setupInference from "./setup-inference.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  resolveSystemAgentVerifiedInferenceRoute,
} from "./verified-inference.js";

// mock-isolation: The setup entrypoint exercises real route/auth owners, never a live model.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

const key = "synthetic-setup-test-key";
const secretRef = { source: "store", provider: "default", id: "SETUP_TEST_KEY" } as const;
const readConfigFileSnapshotOwner = readConfigFileSnapshot;
const readSnapshot = () =>
  readConfigFileSnapshotOwner({ observe: false, pluginValidation: "core-only" });
let temp: TempHomeEnv;
let configPath: string;

async function configuredRoute(
  snapshot: Awaited<ReturnType<typeof readSnapshot>>,
  config = snapshot.runtimeConfig,
) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    config,
    "main",
    { pluginMetadataPlugins: [] },
    snapshot,
  );
  expect(route).not.toBeNull();
  return route!;
}

function directAuth(route: Pick<SystemAgentConfiguredRoute, "runConfig" | "agentDir">) {
  return resolveApiKeyForProviderCore({
    cfg: route.runConfig,
    provider: "fixture",
    modelId: "test-model",
    modelApi: "openai-responses",
    agentDir: route.agentDir,
    store: { version: 1, profiles: {} },
    allowAuthProfileFallback: false,
    secretSentinels: true,
  });
}

function bindRoute(
  route: SystemAgentConfiguredRoute,
  authFingerprint: string | undefined,
  authProfileId?: string,
) {
  return createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: {
      agentHarnessId: "openclaw",
      modelId: "test-model",
      modelApi: "openai-responses",
      authFingerprint,
      ...(authProfileId ? { authProfileId } : {}),
    },
  });
}

async function readRuntime() {
  const snapshot = await readSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  return snapshot.runtimeConfig ?? snapshot.config;
}

async function activate() {
  const snapshot = await readSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  activateSecretsRuntimeSnapshotWithSource(
    await prepareSecretsRuntimeSnapshot({
      config: snapshot.runtimeConfig,
      env: process.env,
      includeAuthStoreRefs: false,
      manifestRegistry: { plugins: [] },
      loadablePluginOrigins: new Map(),
    }),
    snapshot.sourceConfig,
  );
}

function storeKey(value: string) {
  return writeSecretStoreEntry({
    scope: { kind: "team" },
    name: secretRef.id,
    value,
    kind: "secret",
    allowedHosts: ["provider.example"],
    updatedBy: "test",
  });
}

beforeEach(async () => {
  temp = await createTempHomeEnv("openclaw-setup-runtime-");
  configPath = path.join(temp.home, ".openclaw", "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "1");
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    agents: {
      defaults: { model: "fixture/test-model" },
      entries: { main: { workspace: path.join(temp.home, "workspace") } },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-responses",
          baseUrl: "https://provider.example/v1",
          apiKey: secretRef,
          models: [
            {
              id: "test-model",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 1000,
            },
          ],
        },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  await storeKey(key);
  await activate();
  const reader = vi.spyOn(configModule, "readConfigFileSnapshot").mockImplementation(readSnapshot);
  onTestFinished(() => reader.mockRestore());
});

afterEach(async () => {
  vi.mocked(runEmbeddedAgentOwner).mockReset();
  clearAuthProfileMigrationDiagnostics();
  clearSecretsRuntimeSnapshot();
  vi.unstubAllEnvs();
  await temp?.restore();
});

it.each(["fixture", "unrelated"])(
  "scopes verified setup binding to its selected provider when %s requires migration",
  async (affectedProvider) => {
    const cfg = (await readSnapshot()).sourceConfig;
    const profileId = "fixture:selected";
    const credential = { type: "api_key" as const, provider: "fixture", key };
    const agentDir = resolveAgentDir(cfg, "main");
    upsertAuthProfile({ agentDir, profileId, credential });
    setRuntimeAuthProfileStoreSnapshot(
      { version: 1, profiles: { [profileId]: credential } },
      agentDir,
    );
    cfg.agents!.defaults!.model = `fixture/test-model@${profileId}`;
    cfg.auth = { profiles: { [profileId]: { provider: "fixture", mode: "api_key" } } };
    const provider = cfg.models?.providers?.fixture;
    assert(provider);
    delete provider.apiKey;
    await fs.writeFile(configPath, JSON.stringify(cfg));
    const snapshot = await readSnapshot();
    const route = await configuredRoute(snapshot);
    const auth = await resolveApiKeyForProviderCore({
      provider: "fixture",
      cfg: route!.runConfig,
      agentDir,
      profileId,
      lockedProfile: true,
      modelId: "test-model",
      modelApi: "openai-responses",
      secretSentinels: true,
    });
    const legacyPath = path.join(temp.home, "migration-source.json");
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        profiles: {
          legacy: { type: "api_key", provider: affectedProvider, key: "synthetic-legacy-key" },
        },
      }),
    );
    markAuthProfileMigrationRequired(
      agentDir,
      new AuthProfileMigrationRequiredError({
        agentDir,
        sources: [{ kind: "auth-profiles", path: legacyPath }],
      }),
    );
    const binding = bindRoute(route, fingerprintResolvedProviderAuth(auth), profileId);
    if (affectedProvider === "fixture") {
      await expect(binding).rejects.toMatchObject({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" });
    } else {
      await expect(binding).resolves.toMatchObject({ auth: { authProfileId: profileId } });
    }
  },
);

it("keeps protected credentials through a fresh setup read and verified-route revalidation", async () => {
  const snapshot = await readSnapshot();
  const source = snapshot.runtimeConfig;
  expect(source).not.toEqual(snapshot.sourceConfig);
  const route = await configuredRoute(snapshot);
  expect(route!.runConfig.agents?.entries).toHaveProperty("openclaw");
  expect(snapshot.sourceConfig.agents?.defaults?.maxConcurrent).toBeUndefined();
  expect(route!.runConfig.agents?.defaults?.maxConcurrent).toBeGreaterThan(0);
  expect(
    resolveManagedSecretRefRuntimeProviderAuth({ cfg: route!.runConfig, provider: "fixture" })
      ?.apiKey,
  ).toBe(key);
  const binding = await bindRoute(route, fingerprintResolvedProviderAuth(await directAuth(route)));
  expect(await resolveSystemAgentVerifiedInferenceRoute(binding)).not.toBeNull();
  // Neither the persisted input nor the configured-route fingerprint may contain the key.
  expect(source.models?.providers?.fixture?.apiKey).toEqual(secretRef);
  expect(JSON.stringify(binding.executionFingerprint)).not.toContain(key);
  expect(await fs.readFile(configPath, "utf8")).not.toContain(key);

  await storeKey("synthetic-rotated-key");
  await activate();
  expect(await resolveSystemAgentVerifiedInferenceRoute(binding)).toBeNull();
});

it.each(["fixture", "Fixture", " Fixture "])(
  "keeps a staged replacement credential authoritative for %s",
  async (providerKey) => {
    const sourceConfig = (await readSnapshot()).sourceConfig;
    const originalProvider = sourceConfig.models!.providers!.fixture;
    assert(originalProvider);
    delete sourceConfig.models!.providers!.fixture;
    sourceConfig.models!.providers![providerKey] = originalProvider;
    await fs.writeFile(configPath, JSON.stringify(sourceConfig));
    await activate();
    const snapshot = await readSnapshot();
    // Same-route credential repair: the unsaved candidate, not disk, owns the new key.
    const candidate = cloneConfigWithResolutionFacts(snapshot.runtimeConfig);
    const provider = candidate.models?.providers?.[providerKey];
    assert(provider);
    provider.apiKey = "synthetic-replacement-key";
    const candidateRoute = await configuredRoute(snapshot, candidate);
    const replacementAuth = await directAuth(candidateRoute);
    const probeFingerprint = fingerprintResolvedProviderAuth(replacementAuth);
    expect(probeFingerprint).toBeDefined();
    const binding = await bindRoute(candidateRoute, probeFingerprint);
    expect(binding.auth.authFingerprint).toBe(probeFingerprint);
    expect((await readRuntime()).models?.providers?.[providerKey]?.apiKey).toEqual(secretRef);
  },
);

it.each([
  ["protected key", "verify", false, false],
  ["key rotated during probe", "verify", true, false],
  ["staged reference rotated during probe", "candidate", true, false],
  ["existing-model activation rotated during probe", "activate", true, false],
  ["alternate profile available", "verify", false, true],
  ["completion", "complete", false, false],
  ["existing-model activation", "activate", false, false],
  ["non-default fallback owner", "fallback", false, false],
] as const)(
  "verifies the actual setup entrypoint: %s",
  async (_label, entrypoint, rotateBeforeBinding, alternateProfile) => {
    if (entrypoint === "fallback") {
      const config = (await readSnapshot()).sourceConfig;
      config.agents!.ownership = "explicit";
      config.agents!.defaults!.systemAgent = { agentId: "main" };
      config.agents!.entries!.engineering = {
        model: "fixture/test-model",
        params: { temperature: 0.1 },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      await activate();
      expect((await readRuntime()).agents?.entries).toHaveProperty("engineering");
    }
    if (alternateProfile) {
      upsertAuthProfile({
        agentDir: resolveAgentDir(await readRuntime(), "main"),
        profileId: "fixture:alternate",
        credential: { type: "api_key", provider: "fixture", key: "synthetic-alternate-key" },
      });
    }
    const runEmbeddedAgent = vi.fn<typeof runEmbeddedAgentOwner>(async (params) => {
      // Replace only the model turn; use the real planner and credential resolver.
      const store = ensureAuthProfileStore(params.agentDir);
      const prepared = prepareAgentRuntimeAuth({
        config: params.config,
        provider: "fixture",
        modelId: "test-model",
        modelApi: "openai-responses",
        modelBaseUrl: "https://provider.example/v1",
        agentDir: params.agentDir,
        env: {},
        metadataSnapshot: resolvePluginMetadataSnapshot({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: process.env,
        }),
        authProfileStore: store,
      });
      const attempt = prepared.attempts[0];
      if (attempt?.kind !== "direct") {
        throw new Error("Expected the configured direct provider credential");
      }
      expect(attempt.allowAuthProfileFallback).toBe(false);
      const auth = await resolveApiKeyForProviderCore({
        cfg: params.config,
        provider: "fixture",
        modelId: "test-model",
        modelApi: "openai-responses",
        agentDir: params.agentDir,
        store,
        allowAuthProfileFallback: attempt.allowAuthProfileFallback,
        secretSentinels: true,
      });
      expect(looksLikeSecretSentinel(auth.apiKey ?? "")).toBe(true);
      params.onSuccessfulAuthBinding?.({
        agentHarnessId: "openclaw",
        modelId: "test-model",
        modelApi: "openai-responses",
        authFingerprint: fingerprintResolvedProviderAuth(auth),
      });
      if (rotateBeforeBinding) {
        await storeKey("synthetic-rotated-key");
        await activate();
      }
      return {
        meta: {
          durationMs: 1,
          finalAssistantVisibleText: "OK",
          executionTrace: { winnerProvider: "fixture", winnerModel: "test-model" },
        },
      };
    });
    const runtime = {
      log() {},
      error() {},
      exit() {
        throw new Error("Unexpected exit");
      },
    };
    vi.mocked(runEmbeddedAgentOwner).mockImplementation(runEmbeddedAgent);
    const attemptedOwners: Array<string | undefined> = [];
    if (entrypoint === "fallback") {
      const verify = vi
        .spyOn(setupInference, "verifySetupInference")
        .mockImplementation(async (params) => {
          attemptedOwners.push(params.agentId);
          return params.agentId === "main"
            ? { ok: false, status: "auth", error: "Primary owner unavailable" }
            : verifySetupInference({ ...params, bindSession: true });
        });
      onTestFinished(() => verify.mockRestore());
    }
    const boundVerification =
      entrypoint === "verify"
        ? await verifySetupInference({ agentId: "main", bindSession: true, runtime })
        : entrypoint === "fallback"
          ? await verifySystemAgentInferenceWithFallback({
              runtime,
            })
          : undefined;
    const result =
      boundVerification ??
      (entrypoint === "candidate"
        ? await verifySetupInferenceConfig({
            config: (await readSnapshot()).sourceConfig,
            requireExecutionOwner: true,
            runtime,
          })
        : entrypoint === "complete"
          ? await completeSetupInference({ prompt: "Reply with OK", runtime })
          : await activateSetupInference({
              kind: "existing-model",
              surface: "gateway",
              runtime,
            }));
    expect(result.ok, result.ok ? undefined : result.error).toBe(!rotateBeforeBinding);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    if (boundVerification?.ok) {
      expect(
        await resolveSystemAgentVerifiedInferenceRoute(boundVerification.binding),
      ).not.toBeNull();
      if (entrypoint === "fallback") {
        expect(attemptedOwners).toEqual(["main", "engineering"]);
        expect(boundVerification.binding.execution.agentId).toBe("engineering");
        expect(
          boundVerification.binding.execution.runConfig.agents?.entries?.openclaw?.params,
        ).toEqual({
          temperature: 0.1,
        });
      }
    } else if (!result.ok) {
      expect(result.error).toContain("owner changed");
    }
    expect((await readRuntime()).models?.providers?.fixture?.apiKey).toEqual(secretRef);
  },
);

it.each([
  { field: "destination", saved: false },
  { field: "destination", saved: true },
  { field: "reference", saved: false },
  { field: "reference", saved: true },
])(
  "does not lend the active key after changing $field (saved: $saved)",
  async ({ field, saved }) => {
    let snapshot = await readSnapshot();
    let candidate = cloneConfigWithResolutionFacts(snapshot.runtimeConfig);
    const provider = candidate.models?.providers?.fixture;
    assert(provider);
    const expectedRef = field === "reference" ? { ...secretRef, id: "OTHER_KEY" } : secretRef;
    provider.apiKey = expectedRef;
    if (field === "destination") {
      provider.baseUrl = "https://other.example/v1";
    }
    if (saved) {
      await fs.writeFile(configPath, JSON.stringify(candidate));
      snapshot = await readSnapshot();
      candidate = snapshot.runtimeConfig;
    }
    // A fresh read not activated yet cannot reuse the old owner's credentials.
    const route = await configuredRoute(snapshot, candidate);
    expect(
      resolveManagedSecretRefRuntimeProviderAuth({ cfg: route!.runConfig, provider: "fixture" }),
    ).toBeUndefined();
    expect(route!.runConfig.models?.providers?.fixture?.apiKey).toEqual(expectedRef);
  },
);

it("retains the materialized view when no prepared runtime is active", async () => {
  clearSecretsRuntimeSnapshot();
  const snapshot = await readSnapshot();
  const route = await configuredRoute(snapshot);
  expect(route!.runConfig.agents?.defaults?.maxConcurrent).toBeGreaterThan(0);
  expect(route!.runConfig.models?.providers?.fixture?.apiKey).toEqual(secretRef);
  expect(
    resolveManagedSecretRefRuntimeProviderAuth({ cfg: route!.runConfig, provider: "fixture" }),
  ).toBeUndefined();
});
