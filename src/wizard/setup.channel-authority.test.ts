// Hosted setup: the channel step checks the requester before saving credentials and config.
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyWizardPrompter } from "./setup.credentials.test-support.js";
import type { SetupWizardOptions } from "./setup.types.js";

type WriteOptions = { writeOptions?: { assertBeforePublish?: () => void } };
const mocks = vi.hoisted(() => ({
  setupChannels: vi.fn<(config: OpenClawConfig) => Promise<OpenClawConfig>>(),
  writeConfig:
    vi.fn<
      (
        config: OpenClawConfig,
        opts?: WriteOptions,
      ) => Promise<{ path: string; nextConfig: OpenClawConfig }>
    >(),
}));

vi.mock("./setup.shared.js", async (importOriginal) => {
  const config = { agents: { defaults: { workspace: "/tmp/workspace" }, entries: { main: {} } } };
  const snapshot = {
    exists: true,
    valid: true,
    config,
    sourceConfig: config,
    sourceConfigBeforeMigrations: config,
    issues: [],
  };
  return {
    ...(await importOriginal<typeof import("./setup.shared.js")>()),
    readSetupConfigAuthority: async () => ({ snapshot, assertCurrent: () => {} }),
    requireRiskAcknowledgement: async (params: { config: OpenClawConfig }) => params.config,
    requestTelemetryConsent: async (params: { config: OpenClawConfig }) => params.config,
    resolveQuickstartGatewayDefaults: () => ({ port: 19791 }),
    writeWizardConfigFile: mocks.writeConfig,
  };
});
vi.mock("./setup.migration-import.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup.migration-import.js")>()),
  detectSetupMigrationSources: async () => ({ detections: [], providerDescriptors: [] }),
  listSetupMigrationOptions: async () => [],
}));
vi.mock("./setup.workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup.workspace.js")>()),
  resolveSetupWorkspaceSelection: async () => ({
    workspaceDir: "/tmp/workspace",
    allowWorkspaceChange: false,
  }),
}));
vi.mock("./setup.gateway-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup.gateway-config.js")>()),
  configureGatewayForSetup: async ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
    nextConfig,
    settings: { port: 19791, bind: "loopback", authMode: "token" },
  }),
}));
// mock-isolation: keep roster/database creation outside this in-memory fixture.
vi.mock("../commands/onboard-agent.js", () => ({
  ensureOnboardingAgent: async (params: {
    config: OpenClawConfig;
    baseConfig: OpenClawConfig;
  }) => ({
    config: params.config,
    configBase: params.baseConfig,
    agentId: "main",
  }),
}));
vi.mock("../commands/onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-helpers.js")>()),
  DEFAULT_WORKSPACE: "/tmp/workspace",
  printWizardHeader: async () => {},
  probeGatewayReachable: async () => ({ ok: false }),
  summarizeExistingConfig: () => "",
}));
// mock-isolation: keep the process-global channel registry out of this fixture.
vi.mock("../channels/plugins/index.js", () => ({ listChannelPlugins: () => [] }));
vi.mock("../flows/channel-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/channel-setup.js")>()),
  setupChannels: mocks.setupChannels,
}));

import { runSetupWizard } from "./setup.js";

function runWizard(opts: SetupWizardOptions) {
  return runSetupWizard(
    {
      acceptRisk: true,
      flow: "advanced",
      mode: "local",
      workspace: "/tmp/workspace",
      authChoice: "skip",
      ...opts,
    },
    { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    createEmptyWizardPrompter(),
  );
}

beforeEach(() => {
  // Like the config writer, admit the requester synchronously before publication.
  mocks.writeConfig.mockReset().mockImplementation(async (nextConfig, opts) => {
    opts?.writeOptions?.assertBeforePublish?.();
    return { path: "/tmp/openclaw.json", nextConfig };
  });
});

it("checks the hosted session before saving a classic channel credential", async () => {
  mocks.setupChannels.mockImplementationOnce(async (config) => ({
    ...config,
    channels: { telegram: { botToken: "123:setup-token" } },
  }));
  const beforePersistentEffect = vi.fn(async () => {
    throw new Error("Setup session is no longer active");
  });
  await expect(runWizard({ beforePersistentEffect })).rejects.toThrow(
    "Setup session is no longer active",
  );
  expect(beforePersistentEffect).toHaveBeenCalledOnce();
  expect(mocks.writeConfig.mock.calls.some(([config]) => config.channels?.telegram)).toBe(false);
});

it("checks the hosted session when the channel step config publishes", async () => {
  mocks.setupChannels.mockImplementationOnce(async (config) => ({
    ...config,
    channels: { telegram: { enabled: true } },
  }));
  // Authority ends after the channel commit starts, as when the commit waits on a lock.
  let committingChannel = false;
  const publish = mocks.writeConfig.getMockImplementation()!;
  mocks.writeConfig.mockImplementation(async (config, opts) => {
    committingChannel ||= config.channels?.telegram !== undefined;
    return await publish(config, opts);
  });
  const assertPersistentEffectCurrent = vi.fn(() => {
    if (committingChannel) {
      throw new Error("Gateway caller authority is no longer active.");
    }
  });
  await expect(runWizard({ assertPersistentEffectCurrent })).rejects.toThrow(
    "Gateway caller authority is no longer active.",
  );
  expect(
    mocks.writeConfig.mock.settledResults.some(
      (result, index) =>
        result.type === "fulfilled" && mocks.writeConfig.mock.calls[index]?.[0].channels?.telegram,
    ),
  ).toBe(false);
});
