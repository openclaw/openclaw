import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "../plugins/capability-artifact.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginNpmProjectDir } from "../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import * as loader from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";
import { captureSystemAgentOwnerPluginArtifacts } from "./verified-inference.js";

const prepareProvider = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/provider-auth-choice.js").prepareAuthChoiceLoadedPluginProvider
  >(),
);
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
  async ({ replaceDuringProbe, manual }) => {
    if (manual) {
      catalogEntry.mockReturnValue(manualEntry);
    }
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
        const loaded = vi.spyOn(loader, "loadPluginRegistryHandle");
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
        const capture = vi.fn(captureSystemAgentOwnerPluginArtifacts);
        const runEmbeddedAgent = vi.fn<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>(
          async (params) => {
            expect(onPreparationComplete).toHaveBeenCalledOnce();
            params.onSuccessfulAuthBinding?.({
              authProfileId: params.authProfileId,
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
                  winnerProvider: "fixture-provider",
                  winnerModel: "fixture-model",
                },
              },
            };
          },
        );
        const onPreparationComplete = vi.fn(() => {
          expect(capture).toHaveBeenCalledOnce();
          expect(trustedRecord).toBeDefined();
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
        });
        await withPluginRuntimeGenerationScope(
          {
            metadataSnapshot: runningMetadata,
            pluginRegistry: runningRegistry,
          },
          async () => {
            const result = await activateSetupInference({
              kind: manual ? "api-key" : "provider-auth",
              ...(manual ? { apiKey: "synthetic-owner-key" } : {}),
              authChoice: "fixture-provider-key",
              agentId: "main",
              workspace: state.workspaceDir,
              surface: "gateway",
              recordSetupAudit: false,
              runtime: createNonExitingRuntime(),
              onPreparationComplete,
              prompter: createWizardPrompter(),
              deps: {
                resolveManifestProviderAuthChoice: () =>
                  manual
                    ? undefined
                    : {
                        pluginId: "fixture-provider",
                        providerId: "fixture-provider",
                        methodId: "key",
                        choiceId: "fixture-provider-key",
                        choiceLabel: "Fixture",
                        appGuidedSecret: true,
                      },
                captureSystemAgentOwnerPluginArtifacts: capture,
                resolveApiKeyForProvider: async (params) => ({
                  ...resolvedAuth,
                  profileId: params.profileId,
                }),
                runEmbeddedAgent,
              },
            });
            expect(onPreparationComplete).toHaveBeenCalledOnce();
            expect(runEmbeddedAgent).toHaveBeenCalledOnce();
            expect(capture).toHaveBeenCalledOnce();
            const staged = capture.mock.results[0]?.value;
            expect(staged?.ownerPluginIds).toEqual(["fixture-provider"]);
            expect(staged?.ownerPluginArtifacts).toEqual([
              {
                pluginId: "fixture-provider",
                fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
            ]);
            expect(
              loaded.mock.calls.some(
                ([options]) =>
                  options?.installRecords?.["fixture-provider"]?.acceptedSurfaceIntegrity ===
                  integrity,
              ),
            ).toBe(true);
            if (replaceDuringProbe) {
              expect(result).toMatchObject({ ok: false, status: "auth" });
              if (result.ok) {
                throw new Error("Replaced provider artifact was accepted");
              }
              expect(result.error).toContain("owner plugin runtime changed");
              expect(await fs.readFile(state.configPath, "utf8")).toBe(originalBytes);
            } else {
              expect(result).toMatchObject({
                ok: true,
                modelRef: "fixture-provider/fixture-model",
              });
              // The running generation intentionally retains its pre-install cache.
              const records = await withPluginLifecycleLease({}, async () =>
                readPersistedInstalledPluginIndexInstallRecords({ stateDir: state.stateDir }),
              );
              if (!trustedRecord) {
                throw new Error("Installer did not prepare a trusted record");
              }
              expect(records?.["fixture-provider"]).toMatchObject(trustedRecord);
              const committed = await readConfigFileSnapshot();
              expect(committed.sourceConfig.plugins?.installs).toBeUndefined();
              const profiles = loadAuthProfileStoreWithoutExternalProfiles(
                resolveAgentDir(committed.config, "main"),
              ).profiles;
              const credential = Object.values(profiles).find(
                (profile) => profile.provider === "fixture-provider",
              );
              expect(credential).toMatchObject({ type: "api_key", key: "synthetic-owner-key" });
              expect(credential?.setup).toBeUndefined();
            }
            expect(getActivePluginRegistry()).toBe(runningRegistry);
            expect(getCurrentPluginMetadataSnapshot({ config: original.runtimeConfig })).toBe(
              runningMetadata,
            );
            expect(runningMetadata.byPluginId.has("fixture-provider")).toBe(false);
          },
        );
      },
    );
  },
);

it.each([
  { name: "no interactive session", prompt: false, optedIn: true, key: "synthetic-owner-key" },
  { name: "no pasted-key opt-in", prompt: true, optedIn: false, key: "synthetic-owner-key" },
  { name: "empty key", prompt: true, optedIn: true, key: " " },
  {
    name: "declined installation",
    prompt: true,
    optedIn: true,
    key: "synthetic-owner-key",
    decline: true,
  },
])("does not activate a catalog key with $name", async (testCase) => {
  catalogEntry.mockReturnValue({ ...manualEntry, appGuidedSecret: testCase.optedIn });
  prepareProvider.mockImplementation(async (_params, consume) => await consume(null));
  await withOpenClawTestState({ label: "manual-install-rejected" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { slots: { memory: "none" } } });
    const before = await fs.readFile(state.configPath, "utf8");
    const runEmbeddedAgent = vi.fn();
    const result = await activateSetupInference({
      kind: "api-key",
      authChoice: manualEntry.choiceId,
      apiKey: testCase.key,
      surface: "gateway",
      workspace: state.workspaceDir,
      recordSetupAudit: false,
      runtime: createNonExitingRuntime(),
      ...(testCase.prompt ? { prompter: createWizardPrompter() } : {}),
      deps: { resolveManifestProviderAuthChoice: () => undefined, runEmbeddedAgent },
    });
    expect(result.ok).toBe(false);
    expect(prepareProvider).toHaveBeenCalledTimes(testCase.decline ? 1 : 0);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
  });
});
