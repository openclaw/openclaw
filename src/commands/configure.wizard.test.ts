import { describe, expect, it, vi } from "vitest";
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
  resolveGatewayModeProbeSummary: vi.fn(),
  waitForGatewayReachable: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  summarizeExistingConfig: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
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
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  guardCancel: <T>(value: T) => value,
  printWizardHeader: mocks.printWizardHeader,
  probeGatewayReachable: mocks.probeGatewayReachable,
  resolveGatewayModeProbeSummary: mocks.resolveGatewayModeProbeSummary,
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
import { runConfigureWizard } from "./configure.wizard.js";

describe("runConfigureWizard", () => {
  it("persists gateway.mode=local when only the run mode is selected", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.resolveGatewayModeProbeSummary.mockResolvedValue({
      localUrl: "ws://127.0.0.1:18789",
      remoteUrl: "",
      localProbe: { ok: false },
      remoteProbe: null,
      hints: {
        local: "No gateway detected (ws://127.0.0.1:18789)",
        remote: "No remote URL configured yet",
      },
      credentials: {},
    });
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
    mocks.resolveGatewayModeProbeSummary.mockResolvedValue({
      localUrl: "ws://127.0.0.1:18789",
      remoteUrl: "",
      localProbe: { ok: false },
      remoteProbe: null,
      hints: {
        local: "No gateway detected (ws://127.0.0.1:18789)",
        remote: "No remote URL configured yet",
      },
      credentials: {},
    });
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("shares workspace config updates through the common onboarding helper path", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/existing-workspace",
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.resolveGatewayModeProbeSummary.mockResolvedValue({
      localUrl: "ws://127.0.0.1:18789",
      remoteUrl: "",
      localProbe: { ok: false },
      remoteProbe: null,
      hints: {
        local: "No gateway detected (ws://127.0.0.1:18789)",
        remote: "No remote URL configured yet",
      },
      credentials: {},
    });
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });

    const selectQueue = ["local", "workspace", "__continue"];
    mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
    mocks.clackText.mockResolvedValue("/tmp/next-workspace");
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm.mockResolvedValue(false);

    await runConfigureWizard(
      { command: "configure" },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/next-workspace",
      expect.any(Object),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            workspace: "/tmp/next-workspace",
          }),
        }),
      }),
    );
  });

  it("builds the gateway mode probe summary from the configured local port", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(24567);
    mocks.resolveGatewayModeProbeSummary.mockResolvedValue({
      localUrl: "ws://127.0.0.1:24567",
      remoteUrl: "",
      localProbe: { ok: false },
      remoteProbe: null,
      hints: {
        local: "No gateway detected (ws://127.0.0.1:24567)",
        remote: "No remote URL configured yet",
      },
      credentials: {},
    });
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:24567" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.clackSelect.mockResolvedValue("local");
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);

    await runConfigureWizard(
      { command: "configure", sections: [] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.resolveGatewayModeProbeSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        localPort: 24567,
      }),
    );
  });
});
