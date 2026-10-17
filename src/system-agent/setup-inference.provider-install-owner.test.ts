import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "../plugins/capability-artifact.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginNpmProjectDir } from "../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import * as loader from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import { captureSystemAgentOwnerPluginArtifacts } from "./verified-inference.js";

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
vi.mock("../plugins/provider-auth-choice.js", () => ({
  prepareAuthChoiceLoadedPluginProvider: prepareProvider,
}));

afterEach(() => {
  vi.restoreAllMocks();
  prepareProvider.mockReset();
  resetPluginLoaderTestStateForTest();
});

it.each([false, true])(
  "binds a newly installed provider to its real artifact (replace during probe: %s)",
  async (replaceDuringProbe) => {
    await withOpenClawTestState(
      {
        label: "provider-install-owner",
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
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
          const config: OpenClawConfig = {
            ...params.config,
            plugins: {
              ...params.config.plugins,
              entries: { ...params.config.plugins?.entries, [providerId]: { enabled: true } },
            },
            models: {
              providers: {
                [providerId]: {
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
              agentModelOverride: modelRef,
              authProfiles: [],
              pendingPluginInstalls: { [providerId]: trustedRecord },
              persistAuthProfiles: async () => {},
            },
            { id: providerId, label: "Fixture", auth: [] },
          );
        });
        const capture = vi.fn(captureSystemAgentOwnerPluginArtifacts);
        const runEmbeddedAgent = vi.fn<typeof embeddedAgent.runEmbeddedAgent>(async (params) => {
          expect(onPreparationComplete).toHaveBeenCalledOnce();
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
              kind: "provider-auth",
              authChoice: "fixture-provider-key",
              agentId: "main",
              workspace: state.workspaceDir,
              surface: "gateway",
              recordSetupAudit: false,
              runtime: createNonExitingRuntime(),
              onPreparationComplete,
              prompter: createWizardPrompter(),
              deps: {
                resolveManifestProviderAuthChoice: () => ({
                  pluginId: providerId,
                  providerId,
                  methodId: "key",
                  choiceId: "fixture-provider-key",
                  choiceLabel: "Fixture",
                  appGuidedSecret: true,
                }),
                captureSystemAgentOwnerPluginArtifacts: capture,
                resolveApiKeyForProvider: async () => resolvedAuth,
              },
            });
            expect(onPreparationComplete).toHaveBeenCalledOnce();
            expect(runEmbeddedAgent).toHaveBeenCalledOnce();
            expect(capture).toHaveBeenCalledOnce();
            const staged = capture.mock.results[0]?.value;
            expect(staged?.ownerPluginIds).toEqual([providerId]);
            expect(staged?.ownerPluginArtifacts).toEqual([
              { pluginId: providerId, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
            ]);
            expect(
              loaded.mock.calls.some(
                ([options]) =>
                  options?.installRecords?.[providerId]?.acceptedSurfaceIntegrity === integrity,
              ),
            ).toBe(true);
            if (replaceDuringProbe) {
              expect(result).toMatchObject({
                ok: false,
                status: "auth",
                error: expect.stringContaining("owner plugin runtime changed"),
              });
              expect(await fs.readFile(state.configPath, "utf8")).toBe(originalBytes);
            } else {
              expect(result).toMatchObject({
                ok: true,
                modelRef,
              });
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
    );
  },
);
