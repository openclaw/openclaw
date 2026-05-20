import { describe, expect, it, vi } from "vitest";
import {
  repairShellCompletionHealth,
  shellCompletionStatusToHealthFindings,
  type ShellCompletionStatus,
} from "./doctor-completion.js";

function status(overrides: Partial<ShellCompletionStatus>): ShellCompletionStatus {
  return {
    shell: "zsh",
    profileInstalled: true,
    cacheExists: true,
    cachePath: "/tmp/openclaw.zsh",
    usesSlowPattern: false,
    ...overrides,
  };
}

describe("shell completion health", () => {
  it("detects slow dynamic completion profiles", () => {
    expect(shellCompletionStatusToHealthFindings(status({ usesSlowPattern: true }))).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/shell-completion",
        severity: "warning",
        message: expect.stringContaining("slow dynamic completion"),
      }),
    );
  });

  it("detects missing completion cache for installed profiles", () => {
    expect(shellCompletionStatusToHealthFindings(status({ cacheExists: false }))).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/shell-completion",
        severity: "warning",
        message: expect.stringContaining("cache is missing"),
      }),
    );
  });

  it("keeps missing optional completion quiet in non-interactive mode", () => {
    expect(
      shellCompletionStatusToHealthFindings(status({ profileInstalled: false }), {
        nonInteractive: true,
      }),
    ).toEqual([]);
  });

  it("repairs missing completion cache without prompting", async () => {
    const current = status({ cacheExists: false });
    const generateCompletionCache = vi.fn(async () => {
      current.cacheExists = true;
      return true;
    });

    expect(shellCompletionStatusToHealthFindings(current)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("cache is missing"),
      }),
    );

    await expect(
      repairShellCompletionHealth({
        deps: {
          status: current,
          generateCompletionCache,
        },
      }),
    ).resolves.toMatchObject({
      changes: ["Completion cache regenerated at /tmp/openclaw.zsh"],
      warnings: [],
    });
    expect(generateCompletionCache).toHaveBeenCalledTimes(1);
    expect(shellCompletionStatusToHealthFindings(current)).toEqual([]);
  });

  it("repairs slow dynamic completion profiles and clears the next detection", async () => {
    const current = status({ cacheExists: false, usesSlowPattern: true });
    const generateCompletionCache = vi.fn(async () => {
      current.cacheExists = true;
      return true;
    });
    const installCompletion = vi.fn(async () => {
      current.profileInstalled = true;
      current.usesSlowPattern = false;
    });

    expect(shellCompletionStatusToHealthFindings(current)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("slow dynamic completion"),
      }),
    );

    const result = await repairShellCompletionHealth({
      deps: {
        status: current,
        generateCompletionCache,
        installCompletion,
      },
    });

    expect(generateCompletionCache).toHaveBeenCalledTimes(1);
    expect(installCompletion).toHaveBeenCalledWith("zsh", true, "openclaw");
    expect(result).toMatchObject({
      changes: [expect.stringContaining("Shell completion upgraded")],
      warnings: [],
    });
    expect(shellCompletionStatusToHealthFindings(current)).toEqual([]);
  });

  it("prompts before installing optional completion", async () => {
    const confirm = vi.fn(async () => true);
    const generateCompletionCache = vi.fn(async () => true);
    const installCompletion = vi.fn(async () => undefined);

    const result = await repairShellCompletionHealth({
      deps: {
        status: status({ profileInstalled: false, cacheExists: false }),
        confirm,
        generateCompletionCache,
        installCompletion,
      },
    });

    expect(confirm).toHaveBeenCalledWith({
      message: "Enable zsh shell completion for openclaw?",
      initialValue: true,
    });
    expect(generateCompletionCache).toHaveBeenCalledTimes(1);
    expect(installCompletion).toHaveBeenCalledWith("zsh", true, "openclaw");
    expect(result.changes).toContainEqual(expect.stringContaining("Shell completion installed"));
  });
});
