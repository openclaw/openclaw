// Setup completion tests cover final onboarding instructions and paths.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { completionInstallError as wrappedFsError } from "../cli/completion-profile.test-support.js";
import {
  formatCompletionReloadCommand,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
} from "../cli/completion-runtime.js";
import * as completionRuntime from "../cli/completion-runtime.js";
import * as doctorCompletion from "../commands/doctor-completion.js";
import { withEnvAsync } from "../test-utils/env.js";
import { setupWizardShellCompletion } from "./setup.completion.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createPrompter(confirmValue = false) {
  return {
    confirm: vi.fn(async () => confirmValue),
    note: vi.fn(async () => {}),
  };
}

beforeEach(() => vi.restoreAllMocks());

function createDeps(
  shell: "zsh" | "bash" | "fish" | "powershell" = "zsh",
  profileInstalled = false,
  usesSlowPattern = false,
) {
  return {
    checkShellCompletionStatus: vi
      .spyOn(doctorCompletion, "checkShellCompletionStatus")
      .mockResolvedValue({
        shell,
        profileInstalled,
        cacheExists: false,
        cachePath: `/tmp/openclaw.${shell === "powershell" ? "ps1" : shell}`,
        usesSlowPattern,
      }),
    ensureCompletionCacheExists: vi
      .spyOn(doctorCompletion, "ensureCompletionCacheExists")
      .mockResolvedValue(true),
    installCompletion: vi
      .spyOn(completionRuntime, "installCompletion")
      .mockResolvedValue(undefined),
  };
}

describe("setupWizardShellCompletion", () => {
  it("Advanced: prompts; skip means no install", async () => {
    const prompter = createPrompter();
    const deps = createDeps();

    await setupWizardShellCompletion({ flow: "advanced", prompter });

    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expect(deps.ensureCompletionCacheExists).not.toHaveBeenCalled();
    expect(deps.installCompletion).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it.each([
    ["en", true, true, "EACCES"],
    ["zh-TW", false, false, "EACCES"],
    ["en", false, false, "ERR_INVALID_UTF8"],
    ["en", false, false, "ENOSPC"],
  ] as const)(
    "handles completion failure (%s, installed=%s, slow=%s, %s)",
    async (locale, profileInstalled, usesSlowPattern, code) => {
      await withEnvAsync({ OPENCLAW_LOCALE: locale }, async () => {
        const failedPath = "/tmp/read-only/.openclaw-completion-profile-stage";
        const prompter = createPrompter();
        const deps = createDeps("zsh", profileInstalled, usesSlowPattern);
        vi.mocked(deps.installCompletion!).mockRejectedValue(wrappedFsError(code, failedPath));
        if (code === "ENOSPC") {
          await expect(
            setupWizardShellCompletion({ flow: "quickstart", prompter }),
          ).rejects.toThrow("ENOSPC");
          return;
        }

        await expect(
          setupWizardShellCompletion({ flow: "quickstart", prompter }),
        ).resolves.not.toThrow();

        expect(prompter.note).toHaveBeenCalledTimes(1);
        expect(prompter.note).toHaveBeenCalledWith(
          expect.stringContaining("source /tmp/openclaw.zsh"),
          "Shell completion",
        );
        expect(prompter.note).toHaveBeenCalledWith(
          expect.stringContaining(failedPath),
          "Shell completion",
        );
      });
    },
  );

  it.each([true, false])(
    "reports cache generation failure (profile installed=%s)",
    async (profileInstalled) => {
      const prompter = createPrompter();
      const deps = createDeps("zsh", profileInstalled, false);
      vi.mocked(deps.ensureCompletionCacheExists!).mockResolvedValue(false);

      await setupWizardShellCompletion({ flow: "quickstart", prompter });

      expect(deps.ensureCompletionCacheExists).toHaveBeenCalledWith("openclaw", {
        generationMode: "full",
      });
      expect(prompter.note).toHaveBeenCalledWith(
        "Failed to generate completion cache. Run `openclaw completion --write-state --install` later.",
        "Shell completion",
      );
      expect(deps.installCompletion).not.toHaveBeenCalled();
      expect(prompter.note.mock.calls.flat().join("\n")).not.toContain("source /tmp/openclaw.zsh");
    },
  );

  it("localizes advanced prompts and install notes", async () => {
    await withEnvAsync({ OPENCLAW_LOCALE: "zh-CN" }, async () => {
      const prompter = createPrompter(true);
      createDeps();

      await setupWizardShellCompletion({ flow: "advanced", prompter });

      expect(prompter.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "为 openclaw 启用 zsh shell completion？",
        }),
      );
      expect(prompter.note).toHaveBeenCalledWith(
        "Shell completion 已安装。重启 shell 或运行：source ~/.zshrc",
        "Shell completion",
      );
    });
  });

  it.each([{ shell: "zsh" as const, variable: "ZDOTDIR", profileName: ".zshrc" }])(
    "installs and reports the actual configured $shell startup profile",
    async (testCase) => {
      const homeDir = tempDirs.make("openclaw-wizard-completion-home-");
      const stateDir = tempDirs.make("openclaw-wizard-completion-state-");
      const profileRoot = tempDirs.make(`openclaw wizard ${testCase.shell} Ada's !42 profile-`);

      await withEnvAsync(
        {
          HOME: homeDir,
          USERPROFILE: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
          SHELL: `/bin/${testCase.shell}`,
          ZDOTDIR: undefined,
          XDG_CONFIG_HOME: undefined,
          [testCase.variable]: profileRoot,
        },
        async () => {
          const cachePath = resolveCompletionCachePath(testCase.shell, "openclaw");
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, "OPENCLAW_COMPLETION_LOADED=ready\n", "utf8");
          const prompter = createPrompter();

          vi.spyOn(doctorCompletion, "ensureCompletionCacheExists").mockResolvedValue(true);
          await setupWizardShellCompletion({
            flow: "quickstart",
            prompter,
          });

          const profilePath = path.join(profileRoot, testCase.profileName);
          expect(resolveCompletionProfilePath(testCase.shell)).toBe(profilePath);
          await expect(fs.readFile(profilePath, "utf8")).resolves.toContain(cachePath);
          expect(prompter.note).toHaveBeenCalledWith(
            `Shell completion installed. Restart your shell or run: ${formatCompletionReloadCommand(testCase.shell, profilePath)}`,
            "Shell completion",
          );
        },
      );
    },
  );

  it("shows a concrete PowerShell profile reload command after setup", async () => {
    await withEnvAsync({ HOME: "/Users/ada" }, async () => {
      const prompter = createPrompter();
      const deps = createDeps("powershell");

      await setupWizardShellCompletion({ flow: "quickstart", prompter });

      expect(deps.installCompletion).toHaveBeenCalledWith("powershell", true, "openclaw");
      expect(prompter.note).toHaveBeenCalledWith(
        "Shell completion installed. Restart your shell or run: . '/Users/ada/.config/powershell/Microsoft.PowerShell_profile.ps1'",
        "Shell completion",
      );
    });
  });
});
