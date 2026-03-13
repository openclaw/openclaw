import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const promptAuthChoiceGroupedMock = vi.hoisted(() => vi.fn());
const applyAuthChoiceMock = vi.hoisted(() => vi.fn());
const setupChannelsMock = vi.hoisted(() => vi.fn(async (config) => config));
const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn(() => ({ version: 1, profiles: {} })));

const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
}));

vi.mock("./auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped: promptAuthChoiceGroupedMock,
}));

vi.mock("./auth-choice.js", () => ({
  applyAuthChoice: applyAuthChoiceMock,
  warnIfModelConfigLooksOff: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: setupChannelsMock,
}));

vi.mock("./onboard-helpers.js", () => ({
  ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    promptAuthChoiceGroupedMock.mockReset();
    applyAuthChoiceMock.mockReset();
    setupChannelsMock.mockClear();
    ensureWorkspaceAndSessionsMock.mockClear();
    ensureAuthProfileStoreMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("requires --workspace when flags are present", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work" }, runtime, { hasFlags: true });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--workspace"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("requires --workspace in non-interactive mode", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work", nonInteractive: true }, runtime, {
      hasFlags: false,
    });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--workspace"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("exits with code 1 when the interactive wizard is cancelled", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn().mockRejectedValue(new WizardCancelledError()),
      text: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
      outro: vi.fn(),
    });

    await agentsAddCommand({}, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("clears an existing agent model override when vLLM setup exits with config-only changes", async () => {
    const existingConfig = {
      agents: {
        list: [
          {
            id: "work",
            default: true,
            workspace: "/tmp/work",
            agentDir: "/tmp/work-agent",
            model: "vllm/model-a",
          },
        ],
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: existingConfig,
    });
    promptAuthChoiceGroupedMock.mockResolvedValue("vllm");
    applyAuthChoiceMock.mockResolvedValue({
      config: existingConfig,
      clearAgentModelOverride: true,
    });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn().mockResolvedValue(undefined),
      text: vi.fn().mockResolvedValueOnce("Work").mockResolvedValueOnce("/tmp/work"),
      confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
      note: vi.fn().mockResolvedValue(undefined),
      outro: vi.fn().mockResolvedValue(undefined),
    });

    await agentsAddCommand({}, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      agents: {
        list: [
          {
            id: "work",
            default: true,
            workspace: "/tmp/work",
            agentDir: "/tmp/work-agent",
          },
        ],
      },
    });
  });
});
