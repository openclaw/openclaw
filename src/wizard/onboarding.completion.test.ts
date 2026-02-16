import { describe, expect, it, vi } from "vitest";
import { setupOnboardingShellCompletion } from "./onboarding.completion.js";

function createPrompter(confirmValue = false) {
  return {
    confirm: vi.fn(async () => confirmValue),
    note: vi.fn(async () => {}),
  };
}

function createDeps() {
  return {
    resolveCliName: () => "smart-agent-neo",
    checkShellCompletionStatus: vi.fn(async () => ({
      shell: "zsh",
      profileInstalled: false,
      cacheExists: false,
      cachePath: "/tmp/smart-agent-neo.zsh",
      usesSlowPattern: false,
    })),
    ensureCompletionCacheExists: vi.fn(async () => true),
    installCompletion: vi.fn(async () => {}),
  };
}

describe("setupOnboardingShellCompletion", () => {
  it("QuickStart: installs without prompting", async () => {
    const prompter = createPrompter();
    const deps = createDeps();

    await setupOnboardingShellCompletion({ flow: "quickstart", prompter, deps });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(deps.ensureCompletionCacheExists).toHaveBeenCalledWith("smart-agent-neo");
    expect(deps.installCompletion).toHaveBeenCalledWith("zsh", true, "smart-agent-neo");
    expect(prompter.note).toHaveBeenCalled();
  });

  it("Advanced: prompts; skip means no install", async () => {
    const prompter = createPrompter();
    const deps = createDeps();

    await setupOnboardingShellCompletion({ flow: "advanced", prompter, deps });

    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expect(deps.ensureCompletionCacheExists).not.toHaveBeenCalled();
    expect(deps.installCompletion).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
  });
});
