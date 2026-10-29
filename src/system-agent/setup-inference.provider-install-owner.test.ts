import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import * as modelAuth from "../agents/model-auth.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "../plugins/capability-artifact.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginNpmProjectDir } from "../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import * as providerChoices from "../plugins/provider-auth-choices.js";
import type { ProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activateSetupInference } from "./setup-inference-activate.js";

// mock-isolation: Setup probes replace model I/O without loading the embedded runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

const prepareProvider = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/provider-auth-choice.js").prepareAuthChoiceLoadedPluginProvider
  >(),
);
const providerId = "fixture-provider";
const modelRef = `${providerId}/fixture-model`;
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
vi.mock("../plugins/provider-auth-choice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-auth-choice.js")>()),
  prepareAuthChoiceLoadedPluginProvider: prepareProvider,
}));

const catalogEntry = vi.hoisted(() => vi.fn<() => ProviderInstallCatalogEntry | undefined>());
vi.mock("../plugins/provider-install-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-install-catalog.js")>()),
  resolveProviderInstallCatalogEntry: catalogEntry,
}));
const manualEntry: ProviderInstallCatalogEntry = {
  pluginId: "fixture-provider",
  providerId: "fixture-provider",
  methodId: "key",
  choiceId: "fixture-provider-key",
  choiceLabel: "Fixture",
  label: "Fixture",
  origin: "bundled",
  appGuidedSecret: true,
  optionKey: "fixtureApiKey",
  install: { npmSpec: "@fixture/provider@1.0.0", defaultChoice: "npm" },
};

afterEach(() => {
  catalogEntry.mockReset();
  vi.restoreAllMocks();
  prepareProvider.mockReset();
  resetPluginLoaderTestStateForTest();
});

it.each([
  { replaceDuringProbe: false, manual: false },
  { replaceDuringProbe: true, manual: false },
  { replaceDuringProbe: false, manual: true },
])(
  "binds a newly installed provider to its real artifact (replace: $replaceDuringProbe, pasted key: $manual)",
  ({ replaceDuringProbe, manual }) =>
    withOpenClawTestState(
      { label: "provider-install-owner", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        if (manual) {
          catalogEntry.mockReturnValue(manualEntry);
        }
        await state.writeConfig({
          gateway: { mode: "local" },
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: { main: { workspace: state.workspaceDir } },
          },
          plugins: { entries: {} },
        });
        const originalBytes = await fs.readFile(state.configPath, "utf8");
        const original = await readConfigFileSnapshot();
        const runningMetadata = resolvePluginMetadataSnapshot({
          config: original.runtimeConfig,
          workspaceDir: state.workspaceDir,
          env: process.env,
          allowCurrent: false,
        });
        const runningRegistry = createEmptyPluginRegistry();
        setActivePluginRegistry(runningRegistry);
        const projectRoot = resolvePluginNpmProjectDir({
          npmDir: state.statePath("npm"),
          packageName: "@fixture/provider",
        });
        const pluginRoot = path.join(projectRoot, "node_modules", "@fixture", "provider");
        const pluginEntry = path.join(pluginRoot, "index.cjs");
        const pluginSource = `module.exports = {
        id: "fixture-provider", register(api) {
          api.registerProvider({ id: "fixture-provider", label: "Fixture", auth: [] });
        }
      };\n`;
        const integrity = "sha512-" + createHash("sha512").update(pluginSource).digest("base64");
        const resolvedAuth = {
          apiKey: "synthetic-owner-key",
          source: "config",
          mode: "api-key" as const,
        };
        const authFingerprint = fingerprintResolvedProviderAuth(resolvedAuth);
        if (!authFingerprint) {
          throw new Error("Synthetic credential has no fingerprint");
        }
        let trustedRecord: PluginInstallRecord | undefined;
        prepareProvider.mockImplementation(async (params, consume) => {
          if (manual) {
            expect(params.opts).toEqual({
              token: "synthetic-owner-key",
              tokenProvider: "fixture-provider",
              fixtureApiKey: "synthetic-owner-key",
              secretInputMode: "plaintext",
            });
            expect(params.prompter).toBeDefined();
          }
          // Acquisition and auth are synthetic. Discovery, runtime registration,
          // owner fingerprints, activation checks, and final promotion are real.
          await fs.mkdir(pluginRoot, { recursive: true });
          await writeJson(path.join(projectRoot, "package.json"), {
            private: true,
            dependencies: { "@fixture/provider": "1.0.0" },
          });
          await writeJson(path.join(pluginRoot, "package.json"), {
            name: "@fixture/provider",
            version: "1.0.0",
            openclaw: { extensions: ["./index.cjs"] },
          });
          await writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
            id: providerId,
            providers: [providerId],
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          });
          await fs.writeFile(pluginEntry, pluginSource);
          const config: OpenClawConfig = structuredClone(params.config);
          ((config.plugins ??= {}).entries ??= {})[providerId] = { enabled: true };
          config.models = {
            providers: {
              [providerId]: {
                baseUrl: "https://provider.example/v1",
                api: "openai-completions",
                models: [],
              },
            },
          };
          const acceptedSurface = resolvePluginArtifactDeclaredSurface(pluginRoot, process.env, {
            config,
          });
          trustedRecord = {
            source: "npm",
            spec: "@fixture/provider@1.0.0",
            installPath: pluginRoot,
            resolvedName: "@fixture/provider",
            resolvedVersion: "1.0.0",
            integrity,
            acceptedSurface,
            acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
            acceptedSurfaceAt: "2026-09-06T00:00:00.000Z",
            acceptedSurfaceIntegrity: integrity,
          };
          return await consume(
            {
              config,
              agentModelOverride: modelRef,
              authProfiles: [],
              pendingPluginInstalls: { [providerId]: trustedRecord },
              persistAuthProfiles: async () => {},
            },
            { id: providerId, label: "Fixture", auth: [] },
          );
        });
        const phases: string[] = [];
        const runEmbeddedAgent = vi.fn<typeof embeddedAgent.runEmbeddedAgent>(async (params) => {
          phases.push("probe");
          params.onSuccessfulAuthBinding?.({
            authFingerprint,
            agentHarnessId: "openclaw",
            modelId: "fixture-model",
            modelApi: "openai-completions",
          });
          if (replaceDuringProbe) {
            await fs.writeFile(pluginEntry, pluginSource + "// Replaced artifact.\n");
          }
          return {
            meta: {
              durationMs: 1,
              finalAssistantVisibleText: "OK",
              executionTrace: {
                winnerProvider: providerId,
                winnerModel: "fixture-model",
              },
            },
          };
        });
        vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent);
        await withPluginRuntimeGenerationScope(
          {
            metadataSnapshot: runningMetadata,
            pluginRegistry: runningRegistry,
          },
          async () => {
            vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockResolvedValue(resolvedAuth);
            vi.spyOn(providerChoices, "resolveManifestProviderAuthChoice").mockReturnValue(
              manual
                ? undefined
                : {
                    pluginId: providerId,
                    providerId,
                    methodId: "key",
                    choiceId: "fixture-provider-key",
                    choiceLabel: "Fixture",
                    appGuidedSecret: true,
                  },
            );
            const result = await activateSetupInference({
              kind: manual ? "api-key" : "provider-auth",
              ...(manual ? { apiKey: "synthetic-owner-key" } : {}),
              authChoice: "fixture-provider-key",
              agentId: "main",
              workspace: state.workspaceDir,
              surface: "gateway",
              recordSetupAudit: false,
              runtime: createNonExitingRuntime(),
              onPreparationComplete: () => phases.push("prepared"),
              prompter: createWizardPrompter(),
            });
            expect(phases).toEqual(["prepared", "probe"]);
            if (replaceDuringProbe) {
              expect(result).toMatchObject({
                ok: false,
                status: "auth",
                error: expect.stringContaining("owner plugin runtime changed"),
              });
              expect(await fs.readFile(state.configPath, "utf8")).toBe(originalBytes);
            } else {
              expect(result).toMatchObject({ ok: true, modelRef });
              // The running generation intentionally retains its pre-install cache.
              const records = await withPluginLifecycleLease(
                {},
                async () =>
                  await readPersistedInstalledPluginIndexInstallRecordsAsync({
                    stateDir: state.stateDir,
                  }),
              );
              if (!trustedRecord) {
                throw new Error("Installer did not prepare a trusted record");
              }
              expect(records?.[providerId]).toMatchObject(trustedRecord);
            }
            expect(getActivePluginRegistry()).toBe(runningRegistry);
            expect(getCurrentPluginMetadataSnapshot({ config: original.runtimeConfig })).toBe(
              runningMetadata,
            );
            expect(runningMetadata.byPluginId.has(providerId)).toBe(false);
          },
        );
      },
    ),
);

it("stops a pasted-key install when capability consent is denied", async () => {
  catalogEntry.mockReturnValue(manualEntry);
  await withOpenClawTestState({ label: "manual-consent-denied" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { slots: { memory: "none" } } });
    const before = await fs.readFile(state.configPath, "utf8");
    // The managed installer normalizes a declined capability review into a
    // retrySelection result carrying installError, without producing a prepared candidate.
    prepareProvider.mockImplementation(async (params, consume) =>
      consume(
        {
          config: params.config,
          authProfiles: [],
          persistAuthProfiles: async () => {},
          retrySelection: true,
          installError: "Plugin capability consent was declined.",
        },
        { id: "fixture-provider", label: "Fixture", auth: [] },
      ),
    );
    const runEmbeddedAgent = vi.fn<typeof embeddedAgent.runEmbeddedAgent>();
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent);
    vi.spyOn(providerChoices, "resolveManifestProviderAuthChoice").mockReturnValue(undefined);
    const result = await activateSetupInference({
      kind: "api-key",
      authChoice: manualEntry.choiceId,
      apiKey: "synthetic-owner-key",
      surface: "gateway",
      workspace: state.workspaceDir,
      recordSetupAudit: false,
      runtime: createNonExitingRuntime(),
      prompter: createWizardPrompter(),
    });
    expect(result).toMatchObject({
      ok: false,
      disposition: "rejected-before-promotion",
    });
    if (result.ok) {
      throw new Error("Declined capability consent was activated");
    }
    expect(result.error).toContain("capability consent");
    expect(prepareProvider).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
    const committed = await readConfigFileSnapshot();
    const profiles = (
      await loadAuthProfileStoreWithoutExternalProfilesAsync(
        resolveAgentDir(committed.config, "main"),
      )
    ).profiles;
    expect(Object.values(profiles).some((profile) => profile.provider === "fixture-provider")).toBe(
      false,
    );
    const records = await withPluginLifecycleLease({}, async () =>
      readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir: state.stateDir }),
    );
    expect(records?.["fixture-provider"]).toBeUndefined();
  });
});

it("stops a pasted-key install when setup ownership is invalidated before commit", async () => {
  catalogEntry.mockReturnValue(manualEntry);
  await withOpenClawTestState(
    {
      label: "provider-install-owner",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const source: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: {
          defaults: { workspace: state.workspaceDir },
          entries: { main: { workspace: state.workspaceDir } },
        },
        plugins: { entries: {} },
      };
      await state.writeConfig(source);
      const originalBytes = await fs.readFile(state.configPath, "utf8");
      const original = await readConfigFileSnapshot();
      const runningMetadata = resolvePluginMetadataSnapshot({
        config: original.runtimeConfig,
        workspaceDir: state.workspaceDir,
        env: process.env,
        allowCurrent: false,
      });
      const runningRegistry = createEmptyPluginRegistry();
      setActivePluginRegistry(runningRegistry);
      const projectRoot = resolvePluginNpmProjectDir({
        npmDir: state.statePath("npm"),
        packageName: "@fixture/provider",
      });
      const pluginRoot = path.join(projectRoot, "node_modules", "@fixture", "provider");
      const pluginEntry = path.join(pluginRoot, "index.cjs");
      const pluginSource = `module.exports = {
        id: "fixture-provider", register(api) {
          api.registerProvider({ id: "fixture-provider", label: "Fixture", auth: [] });
        }
      };\n`;
      const integrity = "sha512-" + createHash("sha512").update(pluginSource).digest("base64");
      const authFingerprint = fingerprintResolvedProviderAuth({
        apiKey: "synthetic-owner-key",
        source: "config",
        mode: "api-key",
      });
      if (!authFingerprint) {
        throw new Error("Synthetic credential has no fingerprint");
      }
      prepareProvider.mockImplementation(async (params, consume) => {
        await fs.mkdir(pluginRoot, { recursive: true });
        await fs.writeFile(
          path.join(projectRoot, "package.json"),
          JSON.stringify({
            private: true,
            dependencies: { "@fixture/provider": "1.0.0" },
          }),
        );
        await fs.writeFile(
          path.join(pluginRoot, "package.json"),
          JSON.stringify({
            name: "@fixture/provider",
            version: "1.0.0",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        await fs.writeFile(
          path.join(pluginRoot, "openclaw.plugin.json"),
          JSON.stringify({
            id: "fixture-provider",
            providers: ["fixture-provider"],
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          }),
        );
        await fs.writeFile(pluginEntry, pluginSource);
        const config: OpenClawConfig = {
          ...params.config,
          plugins: {
            ...params.config.plugins,
            entries: { ...params.config.plugins?.entries, "fixture-provider": { enabled: true } },
          },
          models: {
            providers: {
              "fixture-provider": {
                baseUrl: "https://provider.example/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        };
        const acceptedSurface = resolvePluginArtifactDeclaredSurface(pluginRoot, process.env, {
          config,
        });
        const trustedRecord: PluginInstallRecord = {
          source: "npm",
          spec: "@fixture/provider@1.0.0",
          installPath: pluginRoot,
          resolvedName: "@fixture/provider",
          resolvedVersion: "1.0.0",
          integrity,
          acceptedSurface,
          acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
          acceptedSurfaceAt: "2026-09-06T00:00:00.000Z",
          acceptedSurfaceIntegrity: integrity,
        };
        return await consume(
          {
            config,
            agentModelOverride: "fixture-provider/fixture-model",
            authProfiles: [
              {
                profileId: "fixture-provider:default",
                credential: {
                  type: "api_key",
                  provider: "fixture-provider",
                  key: "synthetic-owner-key",
                },
              },
            ],
            pendingPluginInstalls: { "fixture-provider": trustedRecord },
            persistAuthProfiles: async () => {},
          },
          { id: "fixture-provider", label: "Fixture", auth: [] },
        );
      });
      // Ownership stays valid through staging and verification, then lapses
      // while the probe turn is in flight — the worst case the commit gate covers.
      let ownershipInvalidated = false;
      const runEmbeddedAgent = vi.fn<typeof embeddedAgent.runEmbeddedAgent>(async (params) => {
        params.onSuccessfulAuthBinding?.({
          authProfileId: params.authProfileId,
          authFingerprint,
          agentHarnessId: "openclaw",
          modelId: "fixture-model",
          modelApi: "openai-completions",
        });
        ownershipInvalidated = true;
        return {
          meta: {
            durationMs: 1,
            finalAssistantVisibleText: "OK",
            executionTrace: {
              winnerProvider: "fixture-provider",
              winnerModel: "fixture-model",
            },
          },
        };
      });
      await withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: runningMetadata,
          pluginRegistry: runningRegistry,
        },
        async () => {
          vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent);
          vi.spyOn(providerChoices, "resolveManifestProviderAuthChoice").mockReturnValue(undefined);
          // Ownership is revalidated inside the commit transform, after the
          // verification turn and before the artifact/credential commit.
          await expect(
            activateSetupInference({
              kind: "api-key",
              apiKey: "synthetic-owner-key",
              authChoice: "fixture-provider-key",
              agentId: "main",
              workspace: state.workspaceDir,
              surface: "gateway",
              recordSetupAudit: false,
              runtime: createNonExitingRuntime(),
              prompter: createWizardPrompter(),
              beforePersistentEffect: async () => {
                if (ownershipInvalidated) {
                  throw new Error("Setup session superseded by a newer owner.");
                }
              },
            }),
          ).rejects.toThrow("superseded");
          expect(runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(await fs.readFile(state.configPath, "utf8")).toBe(originalBytes);
          const records = await withPluginLifecycleLease({}, async () =>
            readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir: state.stateDir }),
          );
          expect(records?.["fixture-provider"]).toBeUndefined();
          const committed = await readConfigFileSnapshot();
          const profiles = (
            await loadAuthProfileStoreWithoutExternalProfilesAsync(
              resolveAgentDir(committed.config, "main"),
            )
          ).profiles;
          expect(
            Object.values(profiles).some(
              (profile) => profile.provider === "fixture-provider" && !profile.setup,
            ),
          ).toBe(false);
          expect(getActivePluginRegistry()).toBe(runningRegistry);
          expect(getCurrentPluginMetadataSnapshot({ config: original.runtimeConfig })).toBe(
            runningMetadata,
          );
        },
      );
    },
  );
});

it.each([
  { name: "no interactive session", prompt: false, optedIn: true, key: "synthetic-owner-key" },
  { name: "no pasted-key opt-in", prompt: true, optedIn: false, key: "synthetic-owner-key" },
  { name: "empty key", prompt: true, optedIn: true, key: " " },
])("does not activate a catalog key with $name", async (testCase) => {
  catalogEntry.mockReturnValue({ ...manualEntry, appGuidedSecret: testCase.optedIn });
  await withOpenClawTestState({ label: "manual-install-rejected" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { slots: { memory: "none" } } });
    const before = await fs.readFile(state.configPath, "utf8");
    const runEmbeddedAgent = vi.fn<typeof embeddedAgent.runEmbeddedAgent>();
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent);
    vi.spyOn(providerChoices, "resolveManifestProviderAuthChoice").mockReturnValue(undefined);
    const result = await activateSetupInference({
      kind: "api-key",
      authChoice: manualEntry.choiceId,
      apiKey: testCase.key,
      surface: "gateway",
      workspace: state.workspaceDir,
      recordSetupAudit: false,
      runtime: createNonExitingRuntime(),
      ...(testCase.prompt ? { prompter: createWizardPrompter() } : {}),
    });
    expect(result.ok).toBe(false);
    expect(prepareProvider).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
  });
});
