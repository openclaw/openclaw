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
  waitForGatewayReachable: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  summarizeExistingConfig: vi.fn(),
  promptGuardModel: vi.fn(),
  resolveGuardModelRefCompatibility: vi.fn(),
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

vi.mock("./guard-model-picker.js", () => ({
  promptGuardModel: mocks.promptGuardModel,
}));

vi.mock("../agents/guard-model.js", () => ({
  resolveGuardModelRefCompatibility: mocks.resolveGuardModelRefCompatibility,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { runConfigureWizard } from "./configure.wizard.js";

describe("runConfigureWizard", () => {
  it("preserves guard model fallbacks when updating guard settings", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            guardModel: {
              primary: "openai/gpt-4o-mini",
              fallbacks: ["openai/gpt-4.1-mini"],
            },
            guardModelAction: "block",
            guardModelOnError: "allow",
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.promptGuardModel.mockResolvedValue({ model: "openai/gpt-4o-mini" });
    mocks.resolveGuardModelRefCompatibility.mockReturnValue({
      compatible: true,
      api: "openai-completions",
    });

    const selectQueue = ["local", "warn", "block"];
    mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    // Skip input guard (false), enable output guard (true)
    mocks.clackConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runConfigureWizard(
      { command: "update", sections: ["guard-model"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            outputGuardModel: {
              primary: "openai/gpt-4o-mini",
              fallbacks: ["openai/gpt-4.1-mini"],
            },
            outputGuardModelAction: "warn",
            outputGuardModelOnError: "block",
          }),
        }),
      }),
    );
    expect(mocks.promptGuardModel).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Output guard model",
      }),
    );
  });

  it("removes legacy guard fields when disabling output guard", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            guardModel: "openai/gpt-4o-mini",
            guardModelAction: "block",
            guardModelOnError: "allow",
            guardModelMaxInputChars: 32000,
            outputGuardModel: "openai/gpt-4o-mini",
            outputGuardModelAction: "block",
            outputGuardModelOnError: "allow",
            outputGuardModelMaxInputChars: 32000,
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackSelect.mockResolvedValue("local");
    // Skip input guard (false), disable output guard (false)
    mocks.clackConfirm.mockResolvedValue(false);

    await runConfigureWizard(
      { command: "update", sections: ["guard-model"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.not.objectContaining({
            guardModel: expect.anything(),
            guardModelAction: expect.anything(),
            guardModelOnError: expect.anything(),
            guardModelMaxInputChars: expect.anything(),
            outputGuardModel: expect.anything(),
            outputGuardModelAction: expect.anything(),
            outputGuardModelOnError: expect.anything(),
            outputGuardModelMaxInputChars: expect.anything(),
          }),
        }),
      }),
    );
  });

  it("keeps existing guard settings when selected guard model is malformed", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            guardModel: "openai/gpt-4o-mini",
            guardModelAction: "block",
            guardModelOnError: "allow",
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.promptGuardModel.mockResolvedValue({ model: "gpt-4o-mini" });
    mocks.clackSelect.mockResolvedValue("local");
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm.mockResolvedValue(true);

    await runConfigureWizard(
      { command: "update", sections: ["guard-model"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            guardModel: "openai/gpt-4o-mini",
            guardModelAction: "block",
            guardModelOnError: "allow",
          }),
        }),
      }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Guard model must use provider/model format"),
      "Guard Model",
    );
  });

  it("keeps existing guard settings when selected guard model is not OpenAI-compatible", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            guardModel: "openai/gpt-4o-mini",
            guardModelAction: "block",
            guardModelOnError: "allow",
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.promptGuardModel.mockResolvedValue({ model: "anthropic/claude-opus-4-6" });
    mocks.resolveGuardModelRefCompatibility.mockReturnValue({
      compatible: false,
      api: "anthropic-messages",
    });
    mocks.clackSelect.mockResolvedValue("local");
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm.mockResolvedValue(true);

    await runConfigureWizard(
      { command: "update", sections: ["guard-model"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            guardModel: "openai/gpt-4o-mini",
            guardModelAction: "block",
            guardModelOnError: "allow",
          }),
        }),
      }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("OpenAI-compatible provider/model"),
      "Guard Model",
    );
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
});
