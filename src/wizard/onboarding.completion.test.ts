import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { generateZshCompletion } from "../cli/completion-cli.js";
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

describe("generateZshCompletion", () => {
  it("emits a no-op leaf function for commands without options", () => {
    const program = new Command();
    program.name("openclaw");
    program.command("empty").description("No options");

    const script = generateZshCompletion(program);

    expect(script).toMatch(/_openclaw_empty\(\) \{\n  return 0\n\}/);
  });
});
