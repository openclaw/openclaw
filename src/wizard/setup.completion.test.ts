import { describe, expect, it, vi } from "vitest";
import { setupWizardShellCompletion } from "./setup.completion.js";

function createPrompter(confirmValue = false) {
  return {
    confirm: vi.fn(async () => confirmValue),
    note: vi.fn(async () => {}),
  };
}

function createDeps() {
  const deps: NonNullable<Parameters<typeof setupWizardShellCompletion>[0]["deps"]> = {
    resolveCliName: () => "gemmaclaw",
    checkShellCompletionStatus: vi.fn(async (_binName: string) => ({
      shell: "zsh" as const,
      profileInstalled: false,
      cacheExists: false,
      cachePath: "/tmp/openclaw.zsh",
      usesSlowPattern: false,
    })),
    ensureCompletionCacheExists: vi.fn(async (_binName: string) => true),
    installCompletion: vi.fn(async () => {}),
  };
  return deps;
}

describe("setupWizardShellCompletion", () => {
  it("QuickStart: installs without prompting", async () => {
    const prompter = createPrompter();
    const deps = createDeps();

    await setupWizardShellCompletion({ flow: "quickstart", prompter, deps });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(deps.ensureCompletionCacheExists).toHaveBeenCalledWith("gemmaclaw");
    expect(deps.installCompletion).toHaveBeenCalledWith("zsh", true, "gemmaclaw");
    expect(prompter.note).toHaveBeenCalled();
  });

  it("Advanced: prompts; skip means no install", async () => {
    const prompter = createPrompter();
    const deps = createDeps();

    await setupWizardShellCompletion({ flow: "advanced", prompter, deps });

    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expect(deps.ensureCompletionCacheExists).not.toHaveBeenCalled();
    expect(deps.installCompletion).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
  });
});
