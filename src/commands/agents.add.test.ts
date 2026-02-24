import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn(),
  warnIfModelConfigLooksOff: vi.fn(),
  promptAuthChoiceGrouped: vi.fn(),
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
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
  ensureAuthProfileStore: authMocks.ensureAuthProfileStore,
}));

vi.mock("./auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped: authMocks.promptAuthChoiceGrouped,
}));

vi.mock("./auth-choice.js", () => ({
  applyAuthChoice: authMocks.applyAuthChoice,
  warnIfModelConfigLooksOff: authMocks.warnIfModelConfigLooksOff,
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: vi.fn(async (cfg: OpenClawConfig) => cfg),
}));

vi.mock("./onboard-helpers.js", () => ({
  ensureWorkspaceAndSessions: vi.fn(async () => {}),
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveAgentDir: vi.fn(() => "/tmp/mock-agent-dir"),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/mock-workspace"),
    resolveDefaultAgentId: vi.fn(() => "main"),
  };
});

vi.mock("../agents/auth-profiles/paths.js", () => ({
  resolveAuthStorePath: vi.fn(() => "/tmp/mock-auth-store.json"),
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.js";

const runtime = createTestRuntime();

function createWizardPrompter(overrides?: { confirmSequence?: boolean[] }) {
  const confirmSeq = overrides?.confirmSequence ?? [false, false];
  let confirmIdx = 0;
  return {
    intro: vi.fn(async () => {}),
    text: vi.fn(async () => "/tmp/mock-workspace"),
    confirm: vi.fn(async () => {
      const val = confirmSeq[confirmIdx] ?? false;
      confirmIdx++;
      return val;
    }),
    note: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
  };
}

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    authMocks.applyAuthChoice.mockClear();
    authMocks.warnIfModelConfigLooksOff.mockClear();
    authMocks.promptAuthChoiceGrouped.mockClear();
    authMocks.ensureAuthProfileStore.mockClear();
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
});

describe("agents add model override guard", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    authMocks.applyAuthChoice.mockClear();
    authMocks.warnIfModelConfigLooksOff.mockClear();
    authMocks.promptAuthChoiceGrouped.mockClear();
    authMocks.ensureAuthProfileStore.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("applies agentModelOverride when no global model primary exists", async () => {
    const baseCfg: OpenClawConfig = {};
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: baseCfg,
    });

    // Wizard: name prompt skipped (passed via opts.name), workspace → confirm
    // confirm sequence: wantsAuth=true
    const prompter = createWizardPrompter({ confirmSequence: [true] });
    wizardMocks.createClackPrompter.mockReturnValue(prompter);

    authMocks.promptAuthChoiceGrouped.mockResolvedValue("anthropic-api-key");
    // Pass through the config that applyAuthChoice receives so the agent
    // entry created by the first applyAgentConfig call is preserved.
    authMocks.applyAuthChoice.mockImplementation(async (params: { config: OpenClawConfig }) => ({
      config: params.config,
      agentModelOverride: "claude-sonnet-4-20250514",
    }));

    await agentsAddCommand({ name: "worker" }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const written = writeConfigFileMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // oxlint-disable-next-line typescript/no-explicit-any
    const agentEntry = (written?.agents as any)?.list?.find(
      (e: { id?: string }) => e.id === "worker",
    );
    expect(agentEntry?.model).toBe("claude-sonnet-4-20250514");
  });

  it("skips agentModelOverride when global model primary is configured", async () => {
    const baseCfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "claude-opus-4-20250514" },
        },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: baseCfg,
    });

    const prompter = createWizardPrompter({ confirmSequence: [true] });
    wizardMocks.createClackPrompter.mockReturnValue(prompter);

    authMocks.promptAuthChoiceGrouped.mockResolvedValue("anthropic-api-key");
    authMocks.applyAuthChoice.mockImplementation(async (params: { config: OpenClawConfig }) => ({
      config: params.config,
      agentModelOverride: "claude-sonnet-4-20250514",
    }));

    await agentsAddCommand({ name: "worker" }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const written = writeConfigFileMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // oxlint-disable-next-line typescript/no-explicit-any
    const agentEntry = (written?.agents as any)?.list?.find(
      (e: { id?: string }) => e.id === "worker",
    );
    expect(agentEntry?.model).toBeUndefined();
  });

  it("skips agentModelOverride when global model is a plain string", async () => {
    const baseCfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "claude-opus-4-20250514",
        },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: baseCfg,
    });

    const prompter = createWizardPrompter({ confirmSequence: [true] });
    wizardMocks.createClackPrompter.mockReturnValue(prompter);

    authMocks.promptAuthChoiceGrouped.mockResolvedValue("anthropic-api-key");
    authMocks.applyAuthChoice.mockImplementation(async (params: { config: OpenClawConfig }) => ({
      config: params.config,
      agentModelOverride: "claude-sonnet-4-20250514",
    }));

    await agentsAddCommand({ name: "worker" }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const written = writeConfigFileMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // oxlint-disable-next-line typescript/no-explicit-any
    const agentEntry = (written?.agents as any)?.list?.find(
      (e: { id?: string }) => e.id === "worker",
    );
    expect(agentEntry?.model).toBeUndefined();
  });
});
