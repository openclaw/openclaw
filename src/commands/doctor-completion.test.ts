// Doctor completion tests cover final doctor status summaries and completion messaging.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  checkShellCompletionStatus,
  doctorShellCompletion,
  shellCompletionStatusToHealthFindings,
  shellCompletionStatusToRepairEffects,
  type ShellCompletionStatus,
} from "./doctor-completion.js";

const installCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../cli/completion-runtime.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    installCompletion: (...args: unknown[]) => installCompletionMock(...args),
  };
});

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

describe("doctorShellCompletion", () => {
  beforeEach(() => {
    installCompletionMock.mockReset();
  });

  it("does not throw when installCompletion fails with EACCES in the slow-pattern upgrade path", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    tempDirs.push(homeDir, stateDir);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/zsh");

    // Create .zshrc with a slow dynamic completion line so usesSlowDynamicCompletion is true
    const zshrc = path.join(homeDir, ".zshrc");
    await fs.writeFile(zshrc, "source <(openclaw completion zsh)\n", "utf8");

    installCompletionMock.mockRejectedValue(
      new Error("EACCES: permission denied, open '/some/.zshrc'"),
    );

    await expect(
      doctorShellCompletion(
        { log: vi.fn(), error: vi.fn() } as unknown as import("../runtime.js").RuntimeEnv,
        {
          confirm: vi.fn(),
          shouldRepair: true,
        } as unknown as import("./doctor-prompter.js").DoctorPrompter,
        { nonInteractive: false },
      ),
    ).resolves.toBeUndefined();
  });

  it("does not throw when installCompletion fails with EACCES in the new-install path", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    tempDirs.push(homeDir, stateDir);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/zsh");

    installCompletionMock.mockRejectedValue(
      new Error("EACCES: permission denied, open '/some/.zshrc'"),
    );

    await expect(
      doctorShellCompletion(
        { log: vi.fn(), error: vi.fn() } as unknown as import("../runtime.js").RuntimeEnv,
        {
          confirm: vi.fn().mockResolvedValue(true),
          shouldRepair: true,
        } as unknown as import("./doctor-prompter.js").DoctorPrompter,
        { nonInteractive: false },
      ),
    ).resolves.toBeUndefined();
  });
});
