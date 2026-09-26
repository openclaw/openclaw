import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { afterEach, aroundEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { promptAuthConfig } from "../commands/configure.gateway-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { maybeHandleProviderPluginSelection } from "../flows/model-picker-provider-setup.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { createNonExitingRuntime } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { useIsolatedStateGuard } from "../test-utils/state-path-guard.js";
import type { WizardSelectParams } from "../wizard/prompts.js";
import { installPluginFromArchive, installPluginFromNpmSpec } from "./install.js";
import { buildNpmResolutionInstallFields } from "./installs.js";
import {
  clearPluginLoaderCache,
  resetPluginLoaderTestStateForTest,
} from "./loader.test-fixtures.js";
import { prepareAuthChoiceLoadedPluginProvider } from "./provider-auth-choice.js";
import { buildPluginRegistrySnapshotReport } from "./status-snapshot.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
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

// Keep the real SQLite lifecycle coordinators under the isolated worker home.
aroundEach(async (runTest) => {
  const testHome = process.env.OPENCLAW_TEST_HOME;
  if (!testHome) {
    throw new Error("Provider auth tests require an isolated test home.");
  }
  await withStateDatabaseCoordinatorRuntimeDirectory(testHome, runTest);
});

useIsolatedStateGuard();
const servers: http.Server[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      for (const server of servers.splice(0)) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      install.mockReset();
      modelPicker.mockReset();
      resetPluginLoaderTestStateForTest();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }
  }),
);

it.each([
  { pluginId: "moonshot", source: "npm" },
  { pluginId: "moonshot", source: "archive" },
  { pluginId: "deepseek", source: "npm" },
  { pluginId: "qwen", source: "npm" },
] as const)(
  "continues $pluginId auth from the $source inventory without reinstalling",
  { timeout: 120_000 },
  async ({ pluginId, source }) => {
    const root = tempDirs.make("provider-npm-installed-", process.env.OPENCLAW_TEST_HOME);
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
                return { profiles: [{ profileId: choice.provider + ":fixture", credential: {
                  type: "api_key", provider: choice.provider, key: "synthetic-test-only"
                } }], defaultModel: choice.provider + "/fixture-model" };
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
        await seedInstalledPluginIndex(
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
        if (pluginId === "moonshot" && source === "npm") {
          const opsDir = path.join(stateDir, "agents", "ops", "agent");
          const siblingDir = path.join(stateDir, "agents", "sibling", "agent");
          const scopedConfig: OpenClawConfig = {
            ...config,
            agents: {
              ownership: "explicit",
              entries: {
                ops: { agentDir: opsDir, workspace: workspaceDir },
                sibling: { agentDir: siblingDir, workspace: path.join(root, "sibling-workspace") },
              },
            },
          };
          const scopedPrompter = createWizardPrompter();
          const selected = await maybeHandleProviderPluginSelection({
            selection: "provider-plugin:moonshot:api-key",
            cfg: scopedConfig,
            agentDir: opsDir,
            workspaceDir,
            runtime: createNonExitingRuntime(),
            prompter: scopedPrompter,
          });
          expect(selected?.model).toBe("moonshot/fixture-model");
          expect(scopedPrompter.text).toHaveBeenCalledExactlyOnceWith({
            message: "moonshot-api-key",
          });
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
          expect(loadPersistedAuthProfileStore(opsDir)?.profiles).toEqual({
            "moonshot:fixture": {
              type: "api_key",
              provider: "moonshot",
              key: "synthetic-test-only",
            },
          });
          expect(loadPersistedAuthProfileStore(siblingDir)?.profiles ?? {}).toEqual({});
        }
      },
    );
  },
);

it("discovers configure auth from only the selected agent workspace", async () => {
  const root = tempDirs.make("configure-workspace-provider-", process.env.OPENCLAW_TEST_HOME);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "ops-workspace");
  const siblingWorkspace = path.join(root, "sibling-workspace");
  const agentDir = path.join(stateDir, "agents", "ops", "agent");
  const siblingDir = path.join(stateDir, "agents", "sibling", "agent");
  const pluginId = "workspace-provider";
  const choiceId = "workspace-provider-api-key";
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(siblingWorkspace, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: pluginId, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      providers: [pluginId],
      providerAuthChoices: [
        {
          provider: pluginId,
          method: "api-key",
          choiceId,
          choiceLabel: "Workspace provider key",
          groupId: pluginId,
          groupLabel: "Workspace provider",
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = { id: "workspace-provider", register(api) {
      api.registerProvider({ id: "workspace-provider", label: "Workspace provider", auth: [{
        id: "api-key", label: "Workspace provider key", kind: "api_key",
        wizard: { choiceId: "workspace-provider-api-key" },
        async run(ctx) {
          await ctx.prompter.text({ message: JSON.stringify({
            agentDir: ctx.agentDir, workspaceDir: ctx.workspaceDir
          }) });
          return { profiles: [{ profileId: "workspace-provider:fixture", credential: {
            type: "api_key", provider: "workspace-provider", key: "synthetic-test-only"
          } }] };
        }
      }] });
    } };`,
  );
  await withEnvAsync(
    {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    },
    async () => {
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "sibling" } },
          entries: {
            ops: { agentDir, workspace: workspaceDir },
            sibling: { agentDir: siblingDir, workspace: siblingWorkspace },
          },
        },
        plugins: { entries: { [pluginId]: { enabled: true } } },
      };
      const prompter = createWizardPrompter({
        select: async <T>({ options }: WizardSelectParams<T>) => {
          const selected =
            options.find((option) => option.value === choiceId) ??
            options.find((option) => option.value === pluginId) ??
            options.find((option) => option.value === "__more");
          if (!selected) {
            throw new Error("Selected workspace provider is missing from configure auth choices");
          }
          return selected.value;
        },
      });
      modelPicker.mockResolvedValue({ models: undefined });
      await promptAuthConfig(config, createNonExitingRuntime(), prompter, {
        agentId: "ops",
        agentDir,
        workspaceDir,
      });
      expect(prompter.text).toHaveBeenCalledExactlyOnceWith({
        message: JSON.stringify({ agentDir, workspaceDir }),
      });
      expect(install).not.toHaveBeenCalled();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual({
        "workspace-provider:fixture": {
          type: "api_key",
          provider: "workspace-provider",
          key: "synthetic-test-only",
        },
      });
      expect(loadPersistedAuthProfileStore(siblingDir)?.profiles ?? {}).toEqual({});
    },
  );
});
