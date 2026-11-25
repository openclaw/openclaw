// Real classic wizard prompts and config IO across agent preparation; host effects are synthetic.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resetConfigRuntimeState } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { t } from "./i18n/index.js";
import { WizardCancelledError, type WizardPrompter, type WizardSelectParams } from "./prompts.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => ({ plugins: [], diagnostics: [] }),
}));
vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  loadPluginManifestRegistryForPluginRegistry: () => ({ plugins: [], diagnostics: [] }),
}));
vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
}));
vi.mock("./setup.shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup.shared.js")>();
  return {
    ...actual,
    writeWizardConfigFile: async (...args: Parameters<typeof actual.writeWizardConfigFile>) => {
      vi.stubEnv("CLASSIC_RESPONSE_PREFIX", "prefix-at-write");
      return await actual.writeWizardConfigFile(...args);
    },
  };
});
vi.mock("./setup.gateway-config.js", () => ({
  configureGatewayForSetup: async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
    vi.stubEnv("CLASSIC_RESPONSE_PREFIX", "prefix-during-ensure");
    return {
      nextConfig: { ...nextConfig, gateway: { ...nextConfig.gateway, mode: "local", port: 19001 } },
      settings: {
        port: 19001,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "fixture-token",
      },
    };
  },
}));
vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources: async () => ({ detections: [], providerDescriptors: [] }),
  listSetupMigrationOptions: async () => [],
  runSetupMigrationImport: vi.fn(),
}));
vi.mock("./setup.memory-import.js", () => ({ runSetupMemoryImportStep: vi.fn() }));
vi.mock("./setup.finalize.js", () => ({
  finalizeSetupWizard: async () => ({ launchedTui: false }),
}));
vi.mock("../commands/onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-helpers.js")>()),
  printWizardHeader: vi.fn(),
  probeGatewayReachable: async () => ({ ok: false }),
  ensureWorkspaceAndSessions: vi.fn(),
}));

import { runSetupWizard } from "./setup.js";

const runtime = {
  log: vi.fn(),
  error: (message: unknown) => {
    throw new Error(String(message));
  },
  exit: (code: number) => {
    throw new Error(`Unexpected exit ${code}`);
  },
};

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

it.each([true, false])("preserves rebased provenance with consent %s", async (acceptRisk) => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspace = path.join(home, "workspace");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("CLASSIC_RESPONSE_PREFIX", "prefix-before");
    await fs.mkdir(stateDir, { recursive: true });
    const config: OpenClawConfig = {
      agents: { defaults: { workspace }, entries: { main: {} } },
      gateway: { mode: "local", port: 18789 },
      messages: { responsePrefix: "${CLASSIC_RESPONSE_PREFIX}" },
      memory: { search: { enabled: false, query: { maxResults: 7 } } },
      plugins: { enabled: false },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    resetConfigRuntimeState();
    const securityConfirm = vi.fn<WizardPrompter["confirm"]>(async () => acceptRisk);
    const memoryConfirm = vi.fn<WizardPrompter["confirm"]>(async () => false);
    const confirm: WizardPrompter["confirm"] = async (params) => {
      if (params.message === t("wizard.security.confirm")) {
        return securityConfirm(params);
      }
      if (params.message === "Set up memory embeddings?") {
        return memoryConfirm(params);
      }
      throw new Error(`Unexpected confirmation: ${params.message}`);
    };
    const prompter = createWizardPrompter({
      confirm,
      select: async <T>(params: WizardSelectParams<T>): Promise<T> => {
        const choice = params.options.find((option) => option.value === false);
        if (!choice) {
          throw new Error(`Unexpected selection: ${params.message}`);
        }
        return choice.value;
      },
    });
    const setup = runSetupWizard(
      {
        flow: "quickstart",
        mode: "local",
        authChoice: "skip",
        agentName: "main",
        workspace,
        gatewayPort: 19001,
        installDaemon: false,
        skipChannels: true,
        skipSearch: true,
        skipSkills: true,
        skipHealth: true,
        skipHooks: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );
    if (!acceptRisk) {
      await expect(setup).rejects.toBeInstanceOf(WizardCancelledError);
      expect(securityConfirm).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: t("wizard.security.confirm"),
          initialValue: true,
          layout: "vertical",
        }),
      );
      expect(memoryConfirm).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(config);
      return;
    }
    await setup;

    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    expect.soft(saved.wizard?.securityAcknowledgedAt).toEqual(expect.any(String));
    expect.soft(saved.telemetry).toEqual({ enabled: false, consentedAt: expect.any(String) });
    expect.soft(saved.gateway?.port).toBe(19001);
    expect.soft(saved.agents?.defaults?.workspace).toBe(workspace);
    expect.soft(saved.agents?.entries).toHaveProperty("main");
    expect.soft(saved.messages?.responsePrefix).toBe("${CLASSIC_RESPONSE_PREFIX}");
    expect.soft(saved.memory).toEqual(config.memory);
    expect.soft(saved.agents?.defaults).not.toHaveProperty("maxConcurrent");
    expect.soft(saved.agents?.defaults).not.toHaveProperty("compaction");
    expect(securityConfirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: t("wizard.security.confirm"),
        initialValue: true,
        layout: "vertical",
      }),
    );
    expect(memoryConfirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "Set up memory embeddings?",
        initialValue: false,
      }),
    );
  });
});
