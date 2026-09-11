import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { promptAuthConfig } from "../commands/configure.gateway-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNonExitingRuntime } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { WizardSelectParams } from "../wizard/prompts.js";
import { installPluginFromArchive, installPluginFromNpmSpec } from "./install.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields } from "./installs.js";
import {
  clearPluginLoaderCache,
  resetPluginLoaderTestStateForTest,
} from "./loader.test-fixtures.js";
import { prepareAuthChoiceLoadedPluginProvider } from "./provider-auth-choice.js";
import { buildPluginRegistrySnapshotReport } from "./status-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { registryPackages, startStaticRegistry } from "./test-helpers/npm-registry-fixtures.js";

const install = vi.hoisted(() =>
  vi.fn<
    typeof import("../commands/onboarding-plugin-install.js").ensureOnboardingPluginInstalled
  >(),
);
const modelPicker = vi.hoisted(() =>
  vi.fn<typeof import("../commands/model-picker.js").promptModelAllowlist>(),
);
vi.mock("../commands/onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled: install,
}));
vi.mock("../commands/model-picker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/model-picker.js")>()),
  promptModelAllowlist: modelPicker,
}));

const tempDirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  install.mockReset();
  modelPicker.mockReset();
  resetPluginLoaderTestStateForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

it.each([
  { pluginId: "moonshot", source: "npm" },
  { pluginId: "moonshot", source: "archive" },
  { pluginId: "deepseek", source: "npm" },
  { pluginId: "qwen", source: "npm" },
] as const)(
  "continues $pluginId auth from the $source inventory without reinstalling",
  { timeout: 120_000 },
  async ({ pluginId, source }) => {
    const root = fs.realpathSync(makeTrackedTempDir("provider-npm-installed", tempDirs));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const npmConfig = path.join(root, "npmrc");
    fs.writeFileSync(npmConfig, "");
    const packageName = `@openclaw/${pluginId}-provider`;
    const methods = pluginId === "moonshot" ? ["api-key", "api-key-cn"] : ["api-key"];
    const choices = methods.map((method) => ({
      provider: pluginId,
      method,
      choiceId: `${pluginId}-${method}`,
      choiceLabel: `${pluginId} ${method}`,
      groupId: pluginId,
      groupLabel: pluginId,
    }));
    const registry = await startStaticRegistry(
      await registryPackages(root, [
        {
          packageName,
          pluginId,
          manifest: { providers: [pluginId], providerAuthChoices: choices },
          indexJs: `export default {
        id: ${JSON.stringify(pluginId)},
        register(api) {
          api.registerProvider({ id: ${JSON.stringify(pluginId)}, label: "Fixture provider",
            auth: ${JSON.stringify(choices)}.map((choice) => ({
              id: choice.method, label: choice.choiceLabel, kind: "api_key",
              // Moonshot 2026.9.3's secondary method omits its manifest choice ID.
              wizard: choice.method === "api-key-cn" ? { groupLabel: "Moonshot" } : { choiceId: choice.choiceId },
              async run(ctx) {
                await ctx.prompter.text({ message: choice.choiceId });
                return { profiles: [], defaultModel: choice.provider + "/fixture-model" };
              }
            }))
          });
        }
      };`,
        },
      ]),
      servers,
    );
    await withEnvAsync(
      {
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        NPM_CONFIG_USERCONFIG: npmConfig,
        npm_config_userconfig: npmConfig,
        NPM_CONFIG_REGISTRY: registry,
        npm_config_registry: registry,
        NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
        npm_config_cache: path.join(root, "npm-cache"),
      },
      async () => {
        const config: OpenClawConfig = {
          gateway: { mode: "local" },
          plugins: { entries: { [pluginId]: { enabled: true } } },
        };
        const archivePath = path.join(root, `openclaw-${pluginId}-provider-1.0.0.tgz`);
        const installOptions = {
          expectedPluginId: pluginId,
          config,
          logger: { info() {}, warn() {} },
        };
        const result =
          source === "npm"
            ? await installPluginFromNpmSpec({
                ...installOptions,
                spec: packageName,
                npmDir: path.join(stateDir, "npm"),
              })
            : await installPluginFromArchive({
                ...installOptions,
                archivePath,
                extensionsDir: path.join(stateDir, "extensions"),
              });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) {
          throw new Error(result.error);
        }
        await writePersistedInstalledPluginIndexInstallRecords(
          {
            [pluginId]: {
              source,
              spec: packageName,
              installPath: result.targetDir,
              ...buildNpmResolutionInstallFields(result.npmResolution),
            },
          },
          { config, workspaceDir },
        );
        clearPluginLoaderCache();
        const report = buildPluginRegistrySnapshotReport({ config, workspaceDir });
        expect(report.plugins.find((plugin) => plugin.id === pluginId)).toMatchObject({
          enabled: true,
          version: "1.0.0",
        });
        install.mockImplementation(async ({ cfg }) => ({
          cfg,
          pluginId,
          installed: true,
          status: "installed",
        }));
        for (const { choiceId } of choices) {
          const prompter = createWizardPrompter();
          await prepareAuthChoiceLoadedPluginProvider(
            {
              authChoice: choiceId,
              config,
              workspaceDir,
              agentId: "main",
              agentDir: path.join(stateDir, "agents", "main", "agent"),
              prompter,
              runtime: createNonExitingRuntime(),
              setDefaultModel: false,
            },
            (prepared, provider) => {
              expect(install, choiceId).not.toHaveBeenCalled();
              expect(prepared?.retrySelection, choiceId).not.toBe(true);
              expect(provider?.id, choiceId).toBe(pluginId);
              expect(prompter.text).toHaveBeenCalledWith({ message: choiceId });
              expect(prepared?.agentModelOverride).toBe(`${pluginId}/fixture-model`);
            },
          );
        }
        const authChoice = pluginId === "moonshot" ? "moonshot-api-key-cn" : `${pluginId}-api-key`;
        const prompter = createWizardPrompter({
          select: async <T>({ options }: WizardSelectParams<T>) => {
            const selected =
              options.find((option) => option.value === authChoice) ??
              options.find((option) => option.value === pluginId) ??
              options.find((option) => option.value === "__more");
            if (!selected) {
              throw new Error("Unexpected configure selection");
            }
            return selected.value;
          },
        });
        modelPicker.mockResolvedValue({ models: undefined });
        await promptAuthConfig(config, createNonExitingRuntime(), prompter, {
          agentId: "main",
          agentDir: path.join(stateDir, "agents", "main", "agent"),
          workspaceDir,
        });
        expect(install, authChoice).not.toHaveBeenCalled();
        expect(prompter.text).toHaveBeenCalledWith({ message: authChoice });
        expect(modelPicker).toHaveBeenCalledOnce();
        expect(modelPicker).toHaveBeenCalledWith(
          expect.objectContaining({ preferredProvider: pluginId }),
        );
      },
    );
  },
);
