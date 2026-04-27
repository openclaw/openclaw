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

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
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

  it("uses peer-level workspace as initialValue for a brand-new agent (#71889)", async () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/Users/me/.openclaw/workspace" },
        list: [{ id: "main", default: true }],
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      parsed: cfg,
      config: cfg,
    });

    const text = vi.fn().mockRejectedValue(new WizardCancelledError());
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn(),
      note: vi.fn(),
      text: vi.fn().mockResolvedValueOnce("freshbug").mockImplementation(text),
      confirm: vi.fn().mockResolvedValue(false),
      outro: vi.fn(),
    });

    await agentsAddCommand({}, runtime);

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Workspace directory",
        initialValue: "/Users/me/.openclaw/workspace-freshbug",
      }),
    );
  });

  it("preserves the existing workspace as initialValue when updating an existing agent (#71889 follow-up)", async () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/Users/me/.openclaw/workspace" },
        list: [
          { id: "main", default: true },
          { id: "agent-007", workspace: "/Users/me/code/agent-007-ws" },
        ],
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      parsed: cfg,
      config: cfg,
    });

    const text = vi.fn().mockRejectedValue(new WizardCancelledError());
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn(),
      note: vi.fn(),
      text: vi.fn().mockResolvedValueOnce("agent-007").mockImplementation(text),
      // First confirm = "Agent already exists. Update it?" → yes
      confirm: vi.fn().mockResolvedValue(true),
      outro: vi.fn(),
    });

    await agentsAddCommand({}, runtime);

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Workspace directory",
        initialValue: "/Users/me/code/agent-007-ws",
      }),
    );
  });
});
