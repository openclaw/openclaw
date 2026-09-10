// Real command/store/planner lifecycle; only remote plugin discovery and Gateway refresh are fixtures.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import { withModelsTempHome } from "../../agents/models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  readPersistedPluginModelCatalogGeneration,
  replacePersistedPluginModelCatalogs,
} from "../../agents/plugin-model-catalog.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeEmptyPluginMetadataOwners } from "../../plugins/current-plugin-metadata.test-support.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createTestWizardPrompter } from "../../test-utils/plugin-setup-wizard.js";
import { maybeMigrateModelCatalogCredentials } from "../doctor-model-catalog-credentials.js";
import { createDoctorPrompter } from "../doctor-prompter.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";
import { modelsAuthLogoutCommand } from "./auth-logout.js";
import { runModelsAuthLoginFlowCore } from "./auth.js";

const boundary = vi.hoisted(() => ({
  providers: [] as ProviderPlugin[],
  afterRefresh: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: () => boundary.providers,
}));
vi.mock("../../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: () => undefined,
  resolvePluginSetupRegistry: () => ({ providers: [] }),
}));
vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: async () => {
    const afterRefresh = boundary.afterRefresh;
    boundary.afterRefresh = undefined;
    await afterRefresh?.();
  },
}));

const provider = "zai";
const removedKey = "synthetic-revoked-lifecycle-key";
const survivorKey = "synthetic-surviving-lifecycle-key";
const runtime = createTestRuntime();

function generated(key: string) {
  return JSON.stringify({
    generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
    providers: {
      zai: {
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKey: key,
        models: [],
      },
    },
  });
}

async function save(agentDir: string, profileId: string, key: string) {
  await upsertAuthProfileWithLockOrThrow({
    agentDir,
    profileId,
    credential: { type: "api_key", provider, key },
  });
}

function configuration(home: string): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }, { id: "owner" }, { id: "other" }],
      defaults: { workspace: path.join(home, "workspace") },
    },
    models: {
      mode: "replace",
      providers: {
        zai: {
          baseUrl: "https://api.z.ai/api/paas/v4",
          api: "openai-completions",
          models: [
            {
              id: "glm-5.1",
              name: "GLM 5.1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1000,
              maxTokens: 100,
            },
          ],
        },
      },
    },
  };
}

function metadata(): Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners"> {
  const owners = {
    ...makeEmptyPluginMetadataOwners(),
    providers: new Map([[provider, [provider]]]),
    modelCatalogProviders: new Map([[provider, [provider]]]),
  };
  return {
    owners,
    manifestRegistry: { plugins: [], diagnostics: [] },
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 1,
      installRecords: {},
      plugins: [
        {
          pluginId: provider,
          enabled: true,
          manifestPath: path.join("synthetic-plugins", provider, "openclaw.plugin.json"),
          manifestHash: "synthetic-manifest",
          rootDir: path.join("synthetic-plugins", provider),
          origin: "bundled",
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
        },
      ],
      diagnostics: [],
    },
  };
}

async function doctor(cfg: OpenClawConfig) {
  return maybeMigrateModelCatalogCredentials({
    cfg,
    runtime,
    prompter: createDoctorPrompter({
      runtime,
      options: { repair: true, yes: true, nonInteractive: true },
    }),
  });
}

afterEach(() => {
  boundary.afterRefresh = undefined;
  boundary.providers = [];
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("auth catalog production lifecycle", () => {
  it("removes a shared OAuth owner while its same-generation local access token differs", async () => {
    await withModelsTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cfg = configuration(home);
      setRuntimeConfigSnapshot(cfg, cfg);
      const agentDir = path.join(stateDir, "agents", "owner", "agent");
      const profileId = "zai:team";
      const local = {
        type: "oauth" as const,
        provider,
        refresh: "synthetic-shared-generation",
        access: "synthetic-local-access",
        expires: Date.now() + 60_000,
      };
      await upsertAuthProfileWithLockOrThrow({ agentDir, profileId, credential: local });
      await upsertAuthProfileWithLockOrThrow({
        profileId,
        credential: { ...local, access: "synthetic-owner-access", expires: Date.now() + 120_000 },
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toMatchObject({
        access: local.access,
      });
      await modelsAuthLogoutCommand({ profileId, agent: "owner", yes: true }, runtime);
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
      expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toBeUndefined();
    });
  });
  it.each([false, true])(
    "keeps current owner credentials usable after logout (legacy=%s)",
    async (legacy) => {
      await withModelsTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const cfg = configuration(home);
        setRuntimeConfigSnapshot(cfg, cfg);
        const agentDir = path.join(stateDir, "agents", "owner", "agent");
        const otherDir = path.join(stateDir, "agents", "other", "agent");
        await save(agentDir, "zai:removed", removedKey);
        await save(agentDir, "zai:survivor", survivorKey);
        await save(otherDir, "zai:independent", "synthetic-independent-key");
        const catalogPath = encodePluginModelCatalogRelativePath(provider);
        for (const dir of [agentDir, otherDir]) {
          replacePersistedPluginModelCatalogs({
            agentDir: dir,
            pluginCatalogWrites: { [catalogPath]: generated(removedKey) },
          });
          if (legacy) {
            await fs.mkdir(path.dirname(path.join(dir, catalogPath)), { recursive: true });
            await fs.writeFile(path.join(dir, catalogPath), generated(removedKey));
            await fs.writeFile(
              `${path.join(dir, catalogPath)}.doctor-importing-interrupted`,
              generated(removedKey),
            );
          }
        }
        const generation = readPersistedPluginModelCatalogGeneration(agentDir);
        await modelsAuthLogoutCommand(
          { profileId: "zai:removed", agent: "owner", yes: true },
          runtime,
        );
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles["zai:removed"]).toBeUndefined();
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles["zai:survivor"]).toMatchObject({
          key: survivorKey,
        });
        replacePersistedPluginModelCatalogs({
          agentDir,
          pluginCatalogWrites: { [catalogPath]: generated(removedKey) },
          catalogGeneration: generation,
        });
        await ensureOpenClawModelsJson(cfg, agentDir, {
          pluginMetadataSnapshot: metadata(),
          env: {},
        });
        await ensureOpenClawModelsJson(cfg, otherDir, {
          pluginMetadataSnapshot: metadata(),
          env: {},
        });
        expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toHaveLength(1);
        expect(loadPersistedPluginModelCatalogsReadOnly(otherDir)).toHaveLength(1);
        expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)[0]?.contents).not.toContain(
          removedKey,
        );
        expect(
          JSON.parse(loadPersistedPluginModelCatalogsReadOnly(agentDir)[0]!.contents).providers.zai,
        ).toBeDefined();
        expect(
          JSON.parse(loadPersistedPluginModelCatalogsReadOnly(otherDir)[0]!.contents).providers.zai,
        ).toBeDefined();
        expect(await doctor(cfg)).toMatchObject({ migrated: 0, warnings: [] });
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles["zai:removed"]).toBeUndefined();
      });
    },
  );

  it("does not let login completion reopen recovery after its saved credential is logged out", async () => {
    await withModelsTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cfg = configuration(home);
      setRuntimeConfigSnapshot(cfg, cfg);
      const agentDir = path.join(stateDir, "agents", "owner", "agent");
      boundary.providers = [
        {
          id: provider,
          label: "Z.AI",
          auth: [
            {
              id: "api-key",
              label: "API key",
              kind: "api_key",
              run: async () => ({
                profiles: [
                  {
                    profileId: "zai:delayed",
                    credential: { type: "api_key", provider, key: removedKey },
                  },
                ],
              }),
            },
          ],
        },
      ];
      let revokedGeneration = "";
      boundary.afterRefresh = async () => {
        await modelsAuthLogoutCommand(
          { profileId: "zai:delayed", agent: "owner", yes: true },
          runtime,
        );
        revokedGeneration = readPersistedPluginModelCatalogGeneration(agentDir);
        const legacyPath = path.join(agentDir, encodePluginModelCatalogRelativePath(provider));
        await fs.mkdir(path.dirname(legacyPath), { recursive: true });
        await fs.writeFile(legacyPath, generated(removedKey));
      };
      await expect(
        runModelsAuthLoginFlowCore({
          provider,
          agent: "owner",
          config: cfg,
          runtime,
          prompter: createTestWizardPrompter(),
        }),
      ).rejects.toThrow(/changed|no longer/i);
      expect(readPersistedPluginModelCatalogGeneration(agentDir)).toBe(revokedGeneration);
      await ensureOpenClawModelsJson(cfg, agentDir, {
        pluginMetadataSnapshot: metadata(),
        env: {},
      });
      // An older generated cache remains non-authoritative after a fresh reopen.
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath(provider)]: generated(removedKey),
        },
      });
      closeOpenClawAgentDatabasesForTest();
      expect(await doctor(cfg)).toMatchObject({
        migrated: 0,
        warnings: [
          expect.stringContaining("does not recover authentication from generated caches"),
        ],
      });
      expect(
        Object.values(loadPersistedAuthProfileStore(agentDir)?.profiles ?? {}),
      ).not.toContainEqual(expect.objectContaining({ key: removedKey }));
    });
  });
});
