import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);

const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));

const warnIfModelConfigLooksOffMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const applyAuthChoiceMock = vi.hoisted(() => vi.fn());
const setupChannelsMock = vi.hoisted(() => vi.fn(async (cfg: unknown) => cfg));
const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

vi.mock("./auth-choice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-choice.js")>()),
  applyAuthChoice: applyAuthChoiceMock,
  warnIfModelConfigLooksOff: warnIfModelConfigLooksOffMock,
}));

vi.mock("./onboard-channels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-channels.js")>()),
  setupChannels: setupChannelsMock,
}));

vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    replaceConfigFileMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    warnIfModelConfigLooksOffMock.mockClear();
    applyAuthChoiceMock.mockClear();
    setupChannelsMock.mockClear();
    ensureWorkspaceAndSessionsMock.mockClear();
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

  it("does not call warnIfModelConfigLooksOff when user skips auth setup", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    let _confirmCallCount = 0;
    const prompter = {
      intro: vi.fn().mockResolvedValue(undefined),
      text: vi.fn().mockResolvedValue("ops"),
      confirm: vi.fn().mockImplementation(() => {
        _confirmCallCount++;
        // 1st confirm: "Update existing agent?" — not reached for new agents
        // 1st confirm: "Copy auth profiles from main?" — No
        // 2nd confirm: "Configure model/auth for this agent now?" — No
        // 3rd confirm: "Route selected channels?" — No
        return Promise.resolve(false);
      }),
      select: vi.fn().mockResolvedValue(undefined),
      multiselect: vi.fn().mockResolvedValue([]),
      note: vi.fn().mockResolvedValue(undefined),
      outro: vi.fn().mockResolvedValue(undefined),
      progress: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
    };
    wizardMocks.createClackPrompter.mockReturnValue(prompter);

    await agentsAddCommand({}, runtime);

    expect(warnIfModelConfigLooksOffMock).not.toHaveBeenCalled();
    expect(setupChannelsMock).toHaveBeenCalled();
  });
});
