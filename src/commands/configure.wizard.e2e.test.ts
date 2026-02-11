import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  clackIntro: vi.fn(),
  clackOutro: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  clackConfirm: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn(),
  resolveGatewayPort: vi.fn(),
  ensureControlUiAssetsBuilt: vi.fn(),
  createClackPrompter: vi.fn(),
  note: vi.fn(),
  printWizardHeader: vi.fn(),
  probeGatewayReachable: vi.fn(),
  waitForGatewayReachable: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  summarizeExistingConfig: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  intro: mocks.clackIntro,
  outro: mocks.clackOutro,
  select: mocks.clackSelect,
  text: mocks.clackText,
  confirm: mocks.clackConfirm,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "~/.openclaw/openclaw.json",
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  writeConfigFile: mocks.writeConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: mocks.ensureControlUiAssetsBuilt,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
  ensureWorkspaceAndSessions: vi.fn(),
  guardCancel: <T>(value: T) => value,
  printWizardHeader: mocks.printWizardHeader,
  probeGatewayReachable: mocks.probeGatewayReachable,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  summarizeExistingConfig: mocks.summarizeExistingConfig,
  waitForGatewayReachable: mocks.waitForGatewayReachable,
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn(),
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(),
}));

vi.mock("./configure.gateway.js", () => ({
  promptGatewayConfig: vi.fn(),
}));

vi.mock("./configure.gateway-auth.js", () => ({
  promptAuthConfig: vi.fn(),
}));

vi.mock("./configure.channels.js", () => ({
  removeChannelConfigWizard: vi.fn(),
}));

vi.mock("./configure.daemon.js", () => ({
  maybeInstallDaemon: vi.fn(),
}));

vi.mock("./onboard-remote.js", () => ({
  promptRemoteGatewayConfig: vi.fn(),
}));

vi.mock("./onboard-skills.js", () => ({
  setupSkills: vi.fn(),
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: vi.fn(),
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import { promptGatewayConfig } from "./configure.gateway.js";
import { runConfigureWizard } from "./configure.wizard.js";

/**
 * A rich config that simulates user-customized settings across many sections.
 * The wizard should preserve ALL of these when only modifying a single section.
 */
function makeRichConfig(): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      port: 18789,
      bind: "loopback",
      auth: {
        mode: "token",
        token: "test-token",
        allowTailscale: true,
      },
      tailscale: { mode: "off", resetOnExit: false },
    },
    tools: {
      media: {
        audio: { enabled: true, language: "en" },
      },
      web: {
        search: { enabled: true, apiKey: "brave-key-123" },
        fetch: { enabled: true },
      },
    },
    skills: {
      entries: {
        "skill-a": { enabled: false },
        "skill-b": { enabled: false },
        "skill-c": { enabled: true, apiKey: "sk-123" },
      },
    },
    agents: {
      defaults: {
        workspace: "~/.openclaw/workspace",
        model: { primary: "anthropic/claude-sonnet-4-5" },
      },
    },
    logging: { level: "info" },
    web: { enabled: true },
  } as OpenClawConfig;
}

function setupCommonMocks(baseConfig: OpenClawConfig) {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    exists: true,
    valid: true,
    config: baseConfig,
    issues: [],
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
  mocks.resolveControlUiLinks.mockReturnValue({
    wsUrl: "ws://127.0.0.1:18789",
    httpUrl: "http://127.0.0.1:18789",
  });
  mocks.summarizeExistingConfig.mockReturnValue("Gateway: local ...");
  mocks.createClackPrompter.mockReturnValue({});
  mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
  mocks.waitForGatewayReachable.mockResolvedValue({ ok: true });
  mocks.writeConfigFile.mockResolvedValue(undefined);
}

const testRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists gateway.mode=local when only the run mode is selected", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});

    const selectQueue = ["local", "__continue"];
    mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackText.mockResolvedValue("");
    mocks.clackConfirm.mockResolvedValue(false);

    await runConfigureWizard(
      { command: "configure" },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
    );
  });

  it("exits with code 1 when configure wizard is cancelled", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  describe("preserves custom keys when configuring a single section", () => {
    it("preserves tools, skills, and gateway.auth when only 'model' section is configured", async () => {
      const baseConfig = makeRichConfig();
      setupCommonMocks(baseConfig);

      // Mock promptAuthConfig to simulate real behavior: spread-preserving
      vi.mocked(promptAuthConfig).mockImplementation(async (cfg) => ({
        ...cfg,
        auth: {
          ...cfg.auth,
          profiles: { "anthropic:default": { provider: "anthropic", mode: "api_key" as const } },
        },
      }));

      // Mode selection: "local"
      mocks.clackSelect.mockResolvedValue("local");

      await runConfigureWizard({ command: "configure", sections: ["model"] }, testRuntime);

      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
      const written = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;

      // Custom tools.media.audio must survive
      expect(written.tools?.media?.audio).toEqual(
        expect.objectContaining({ enabled: true, language: "en" }),
      );

      // Custom tools.web.search.apiKey must survive
      expect(written.tools?.web?.search?.apiKey).toBe("brave-key-123");

      // gateway.auth.allowTailscale must survive
      expect(written.gateway?.auth?.allowTailscale).toBe(true);
      expect(written.gateway?.auth?.token).toBe("test-token");

      // Disabled skill entries must survive
      expect(written.skills?.entries?.["skill-a"]?.enabled).toBe(false);
      expect(written.skills?.entries?.["skill-b"]?.enabled).toBe(false);
      expect(written.skills?.entries?.["skill-c"]?.apiKey).toBe("sk-123");

      // Other top-level sections must survive
      expect(written.logging).toEqual({ level: "info" });
      expect(written.web).toEqual({ enabled: true });
    });

    it("preserves tools and skills when only 'gateway' section is configured", async () => {
      const baseConfig = makeRichConfig();
      setupCommonMocks(baseConfig);

      // Mock promptGatewayConfig to simulate real behavior
      vi.mocked(promptGatewayConfig).mockImplementation(async (cfg) => ({
        config: {
          ...cfg,
          gateway: {
            ...cfg.gateway,
            mode: "local" as const,
            port: 9999,
            bind: "lan" as const,
            auth: { mode: "token" as const, token: "new-token", allowTailscale: true },
            tailscale: { mode: "off" as const, resetOnExit: false },
          },
        },
        port: 9999,
        token: "new-token",
      }));

      mocks.clackSelect.mockResolvedValue("local");

      await runConfigureWizard({ command: "configure", sections: ["gateway"] }, testRuntime);

      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
      const written = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;

      // tools.media.audio must survive a gateway-only change
      expect(written.tools?.media?.audio).toEqual(
        expect.objectContaining({ enabled: true, language: "en" }),
      );

      // Disabled skills must survive
      expect(written.skills?.entries?.["skill-a"]?.enabled).toBe(false);
      expect(written.skills?.entries?.["skill-b"]?.enabled).toBe(false);

      // Gateway was intentionally changed
      expect(written.gateway?.port).toBe(9999);
    });

    it("preserves all keys in interactive loop when only one section is picked", async () => {
      const baseConfig = makeRichConfig();
      setupCommonMocks(baseConfig);

      // Mock promptAuthConfig to simulate real behavior
      vi.mocked(promptAuthConfig).mockImplementation(async (cfg) => ({
        ...cfg,
        auth: {
          ...cfg.auth,
          profiles: { "anthropic:default": { provider: "anthropic", mode: "api_key" as const } },
        },
      }));

      // Interactive loop: select "local" mode, then "model", then "__continue"
      const selectQueue = ["local", "model", "__continue"];
      mocks.clackSelect.mockImplementation(async () => selectQueue.shift());

      await runConfigureWizard({ command: "configure" }, testRuntime);

      expect(mocks.writeConfigFile).toHaveBeenCalled();
      const written = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;

      // All custom keys must survive
      expect(written.tools?.media?.audio).toEqual(
        expect.objectContaining({ enabled: true, language: "en" }),
      );
      expect(written.gateway?.auth?.allowTailscale).toBe(true);
      expect(written.skills?.entries?.["skill-a"]?.enabled).toBe(false);
      expect(written.skills?.entries?.["skill-b"]?.enabled).toBe(false);
      expect(written.logging).toEqual({ level: "info" });
      expect(written.web).toEqual({ enabled: true });
    });

    it("recovers dropped top-level keys when a section handler omits them", async () => {
      const baseConfig = makeRichConfig();
      setupCommonMocks(baseConfig);

      // Simulate a handler that forgets to spread the full config — returns
      // only the keys it explicitly sets, dropping tools/skills/logging/web.
      vi.mocked(promptAuthConfig).mockImplementation(
        async () =>
          ({
            gateway: { mode: "local" as const, port: 18789 },
            agents: {
              defaults: {
                workspace: "~/.openclaw/workspace",
                model: { primary: "anthropic/claude-sonnet-4-5" },
              },
            },
            auth: {
              profiles: {
                "anthropic:default": { provider: "anthropic", mode: "api_key" as const },
              },
            },
          }) as OpenClawConfig,
      );

      mocks.clackSelect.mockResolvedValue("local");

      await runConfigureWizard({ command: "configure", sections: ["model"] }, testRuntime);

      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
      const written = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;

      // Base config keys that the handler dropped must be recovered
      expect(written.tools?.media?.audio).toEqual(
        expect.objectContaining({ enabled: true, language: "en" }),
      );
      expect(written.skills?.entries?.["skill-a"]?.enabled).toBe(false);
      expect(written.logging).toEqual({ level: "info" });
      expect(written.web).toEqual({ enabled: true });
    });
  });
});
