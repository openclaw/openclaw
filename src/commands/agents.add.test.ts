import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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

vi.mock("./auth-choice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-choice.js")>()),
  warnIfModelConfigLooksOff: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./onboard-channels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-channels.js")>()),
  setupChannels: vi.fn().mockImplementation(async (cfg) => cfg),
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    ensureWorkspaceAndSessionsMock.mockClear();
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

  it("passes skipBootstrap: true to ensureWorkspaceAndSessions when --skip-bootstrap is set (non-interactive)", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand(
      { name: "myagent", workspace: "/tmp/ws", nonInteractive: true, skipBootstrap: true },
      runtime,
      { hasFlags: true },
    );

    expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ skipBootstrap: true }),
    );
  });

  it("passes skipBootstrap: false to ensureWorkspaceAndSessions when --skip-bootstrap is not set (non-interactive)", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand(
      { name: "myagent", workspace: "/tmp/ws", nonInteractive: true },
      runtime,
      { hasFlags: true },
    );

    expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ skipBootstrap: false }),
    );
  });

  it("passes skipBootstrap: true to ensureWorkspaceAndSessions when --skip-bootstrap is set (interactive)", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn().mockResolvedValue(undefined),
      text: vi.fn().mockResolvedValue("/tmp/ws"),
      confirm: vi.fn().mockResolvedValue(false),
      note: vi.fn().mockResolvedValue(undefined),
      outro: vi.fn().mockResolvedValue(undefined),
    });

    await agentsAddCommand({ name: "myagent", skipBootstrap: true }, runtime);

    expect(ensureWorkspaceAndSessionsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ skipBootstrap: true }),
    );
  });
});
