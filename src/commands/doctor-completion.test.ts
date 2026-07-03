// Doctor completion tests cover final doctor status summaries, completion messaging,
// and graceful degradation when shell-completion install hits permission errors.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as completionRuntime from "../cli/completion-runtime.js";
import { createNonExitingRuntime } from "../runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  checkShellCompletionStatus,
  doctorShellCompletion,
  shellCompletionStatusToHealthFindings,
  shellCompletionStatusToRepairEffects,
  type ShellCompletionStatus,
} from "./doctor-completion.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const originalEnv = captureEnv(["HOME", "OPENCLAW_STATE_DIR", "SHELL"]);
const tempDirs: string[] = [];

afterEach(async () => {
  originalEnv.restore();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function status(overrides: Partial<ShellCompletionStatus> = {}): ShellCompletionStatus {
  return {
    shell: "zsh",
    profileInstalled: true,
    cacheExists: true,
    cachePath: "/tmp/openclaw.zsh",
    usesSlowPattern: false,
    ...overrides,
  };
}

describe("shell completion health mapping", () => {
  it("checks an explicit shell instead of the detected environment shell", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    tempDirs.push(homeDir, stateDir);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/zsh");

    const current = await checkShellCompletionStatus("openclaw", { shell: "fish" });

    expect(current.shell).toBe("fish");
    expect(current.cachePath).toBe(path.join(stateDir, "completions", "openclaw.fish"));
    expect(current.profileInstalled).toBe(false);
    expect(current.cacheExists).toBe(false);
  });

  it("reports slow dynamic shell completion with dry-run effects", () => {
    const current = status({ usesSlowPattern: true, cacheExists: false });

    expect(shellCompletionStatusToHealthFindings(current)).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/shell-completion",
        severity: "info",
        path: "shellCompletion.zsh",
      }),
    ]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual([
      {
        kind: "state",
        action: "would-generate-completion-cache",
        target: "/tmp/openclaw.zsh",
        dryRunSafe: true,
      },
      {
        kind: "file",
        action: "would-upgrade-shell-profile-completion",
        target: "zsh",
        dryRunSafe: false,
      },
    ]);
  });

  it("reports missing completion cache with a dry-run cache effect", () => {
    const current = status({ profileInstalled: true, cacheExists: false });

    expect(shellCompletionStatusToHealthFindings(current)).toEqual([
      expect.objectContaining({
        severity: "info",
        message: expect.stringContaining("cache is missing"),
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    ]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual([
      {
        kind: "state",
        action: "would-regenerate-completion-cache",
        target: "/tmp/openclaw.zsh",
        dryRunSafe: true,
      },
    ]);
  });

  it("keeps healthy shell completion quiet", () => {
    const current = status();

    expect(shellCompletionStatusToHealthFindings(current)).toEqual([]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual([]);
  });
});

describe("doctorShellCompletion EACCES degradation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("degrades to a warning when installCompletion fails with EACCES during slow-profile upgrade", async () => {
    // Mock the completion-runtime helpers so checkShellCompletionStatus returns
    // a slow-dynamic status with an existing cache, which reaches the
    // installCompletion code path without needing cache generation.
    vi.spyOn(completionRuntime, "usesSlowDynamicCompletion").mockResolvedValue(true);
    vi.spyOn(completionRuntime, "completionCacheExists").mockResolvedValue(true);
    vi.spyOn(completionRuntime, "isCompletionInstalled").mockResolvedValue(true);
    vi.spyOn(completionRuntime, "resolveShellFromEnv").mockReturnValue("bash" as const);
    const installSpy = vi
      .spyOn(completionRuntime, "installCompletion")
      .mockRejectedValue(new Error("EACCES: permission denied, open '/sandbox/.bashrc'"));

    const prompter: DoctorPrompter = {
      confirm: vi.fn(async () => true),
      confirmAutoFix: vi.fn(async () => true),
      confirmAggressiveAutoFix: vi.fn(async () => true),
      confirmRuntimeRepair: vi.fn(async () => true),
      select: vi.fn(
        async (_params: unknown, fallback: unknown) => fallback,
      ) as DoctorPrompter["select"],
      shouldRepair: true,
      shouldForce: false,
      repairMode: "fix" as const,
    };

    // Must not throw — the EACCES error must degrade to a warning.
    await expect(
      doctorShellCompletion(createNonExitingRuntime(), prompter),
    ).resolves.toBeUndefined();

    expect(installSpy).toHaveBeenCalledOnce();
  });
});
