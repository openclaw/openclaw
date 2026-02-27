import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendAvailability } from "../agents/cli-backend-availability.js";
import { applyAuthChoiceCliBackends } from "./auth-choice.apply.cli-backends.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

vi.mock("../agents/cli-backend-availability.js", () => ({
  checkCliBackendAvailability: vi.fn(),
  formatCliBackendStatus: vi.fn(() => "mock status"),
}));

const { checkCliBackendAvailability } = await import("../agents/cli-backend-availability.js");
const mockCheck = vi.mocked(checkCliBackendAvailability);

function createParams(
  authChoice: ApplyAuthChoiceParams["authChoice"],
  overrides: Partial<ApplyAuthChoiceParams> = {},
): ApplyAuthChoiceParams {
  return {
    authChoice,
    config: {},
    prompter: createWizardPrompter({}, { defaultSelect: "" }),
    runtime: createExitThrowingRuntime(),
    setDefaultModel: true,
    ...overrides,
  };
}

function mockAvailability(overrides: Partial<CliBackendAvailability>): CliBackendAvailability {
  return {
    id: "claude-cli",
    binaryName: "claude",
    binaryFound: true,
    binaryPath: "/usr/local/bin/claude",
    credentialsFound: true,
    credentialsPath: "/home/user/.claude/.credentials.json",
    configDirExists: true,
    configDirPath: "/home/user/.claude",
    ...overrides,
  };
}

describe("applyAuthChoiceCliBackends", () => {
  beforeEach(() => {
    mockCheck.mockReset();
  });

  it("returns null for unrelated authChoice", async () => {
    const result = await applyAuthChoiceCliBackends(createParams("openrouter-api-key"));
    expect(result).toBeNull();
  });

  it("sets claude-cli/sonnet when binary found and setDefaultModel is true", async () => {
    mockCheck.mockResolvedValue(mockAvailability({ id: "claude-cli", binaryFound: true }));
    const note = vi.fn(async () => {});
    const params = createParams("claude-cli", {
      prompter: createWizardPrompter({ note }, { defaultSelect: "" }),
      setDefaultModel: true,
    });

    const result = await applyAuthChoiceCliBackends(params);

    expect(result).not.toBeNull();
    expect(result!.config.agents?.defaults?.model).toEqual({
      primary: "claude-cli/sonnet",
    });
    expect(note).toHaveBeenCalledWith("Default model set to claude-cli/sonnet", "Model configured");
  });

  it("sets codex-cli/codex when binary found and setDefaultModel is true", async () => {
    mockCheck.mockResolvedValue(
      mockAvailability({ id: "codex-cli", binaryName: "codex", binaryFound: true }),
    );
    const note = vi.fn(async () => {});
    const params = createParams("codex-cli", {
      prompter: createWizardPrompter({ note }, { defaultSelect: "" }),
      setDefaultModel: true,
    });

    const result = await applyAuthChoiceCliBackends(params);

    expect(result).not.toBeNull();
    expect(result!.config.agents?.defaults?.model).toEqual({
      primary: "codex-cli/codex",
    });
  });

  it("warns and returns unchanged config when binary not found", async () => {
    mockCheck.mockResolvedValue(mockAvailability({ binaryFound: false, binaryPath: undefined }));
    const note = vi.fn(async () => {});
    const params = createParams("claude-cli", {
      prompter: createWizardPrompter({ note }, { defaultSelect: "" }),
    });

    const result = await applyAuthChoiceCliBackends(params);

    expect(result).toEqual({ config: params.config });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Install the claude CLI"),
      "Binary not found",
    );
  });

  it("returns unchanged config when setDefaultModel is false", async () => {
    mockCheck.mockResolvedValue(mockAvailability({ binaryFound: true }));
    const params = createParams("claude-cli", {
      setDefaultModel: false,
    });

    const result = await applyAuthChoiceCliBackends(params);

    expect(result).not.toBeNull();
    expect(result!.config).toBe(params.config);
  });
});
