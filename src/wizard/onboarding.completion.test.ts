import { describe, expect, it, vi } from "vitest";
import { setupOnboardingShellCompletion } from "./onboarding.completion.js";

describe("setupOnboardingShellCompletion", () => {
  it("QuickStart: installs without prompting", async () => {
    const prompter = {
      confirm: vi.fn(async () => false),
      note: vi.fn(async () => {}),
    };

    const deps = {
      resolveCliName: () => "openclaw",
      checkShellCompletionStatus: vi.fn(async () => ({
        shell: "zsh",
        profileInstalled: false,
        cacheExists: false,
        cachePath: "/tmp/openclaw.zsh",
        usesSlowPattern: false,
      })),
      ensureCompletionCacheExists: vi.fn(async () => true),
      installCompletion: vi.fn(async () => {}),
    };

    await setupOnboardingShellCompletion({ flow: "quickstart", prompter, deps });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(deps.ensureCompletionCacheExists).toHaveBeenCalledWith("openclaw");
    expect(deps.installCompletion).toHaveBeenCalledWith("zsh", true, "openclaw");
    expect(prompter.note).toHaveBeenCalled();
  });

  it("Advanced: prompts; skip means no install", async () => {
    const prompter = {
      confirm: vi.fn(async () => false),
      note: vi.fn(async () => {}),
    };

    const deps = {
      resolveCliName: () => "openclaw",
      checkShellCompletionStatus: vi.fn(async () => ({
        shell: "zsh",
        profileInstalled: false,
        cacheExists: false,
        cachePath: "/tmp/openclaw.zsh",
        usesSlowPattern: false,
      })),
      ensureCompletionCacheExists: vi.fn(async () => true),
      installCompletion: vi.fn(async () => {}),
    };

    await setupOnboardingShellCompletion({ flow: "advanced", prompter, deps });

    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expect(deps.ensureCompletionCacheExists).not.toHaveBeenCalled();
    expect(deps.installCompletion).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
  });
});
