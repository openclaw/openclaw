import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setupChannelsMock = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const warnIfModelConfigLooksOffMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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

vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: setupChannelsMock,
}));

vi.mock("./auth-choice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-choice.js")>()),
  warnIfModelConfigLooksOff: warnIfModelConfigLooksOffMock,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    ensureWorkspaceAndSessionsMock.mockClear();
    setupChannelsMock.mockClear();
    warnIfModelConfigLooksOffMock.mockClear();
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

  it("uses --workspace as the interactive wizard default", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    const prompter = {
      intro: vi.fn().mockResolvedValue(undefined),
      text: vi.fn().mockResolvedValue("/tmp/workspace-work"),
      confirm: vi.fn().mockResolvedValue(false),
      note: vi.fn(),
      outro: vi.fn().mockResolvedValue(undefined),
    };
    wizardMocks.createClackPrompter.mockReturnValue(prompter);

    await agentsAddCommand({ name: "Work", workspace: "/tmp/workspace-work" }, runtime, {
      hasFlags: false,
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Workspace directory",
        initialValue: "/tmp/workspace-work",
      }),
    );
    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledWith(
      "/tmp/workspace-work",
      runtime,
      expect.objectContaining({ agentId: "work" }),
    );
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
});
