// Doctor completion tests cover final doctor status summaries and completion messaging.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  checkShellCompletionStatus,
  doctorShellCompletion,
  shellCompletionStatusToHealthFindings,
  shellCompletionStatusToRepairEffects,
  type ShellCompletionStatus,
} from "./doctor-completion.js";

const originalEnv = captureEnv(["HOME", "OPENCLAW_STATE_DIR", "SHELL"]);
const tempDirs: string[] = [];

afterEach(async () => {
  originalEnv.restore();
  vi.restoreAllMocks();
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

const installCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../cli/completion-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/completion-runtime.js")>();
  return {
    ...actual,
    installCompletion: installCompletionMock,
  };
});

describe("doctorShellCompletion", () => {
  beforeEach(() => {
    installCompletionMock.mockReset();
  });

  it("handles EACCES gracefully when installing completion", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-state-"));
    tempDirs.push(homeDir, stateDir);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/bash");

    const bashrcPath = path.join(homeDir, ".bashrc");
    await fs.writeFile(
      bashrcPath,
      '# test bashrc\n[ -f "/tmp/nonexistent" ] && source <(openclaw completion bash)\n',
      "utf-8",
    );

    const cacheDir = path.join(stateDir, "completions");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "openclaw.bash"), "# completion cache\n", "utf-8");

    const eaccesError = new Error(
      `EACCES: permission denied, open '${bashrcPath}'`,
    ) as NodeJS.ErrnoException;
    eaccesError.code = "EACCES";
    installCompletionMock.mockRejectedValue(eaccesError);

    const noteSpy = vi.spyOn(noteModule, "note");

    await expect(
      doctorShellCompletion({} as never, {
        confirm: async () => true,
      }),
    ).resolves.not.toThrow();

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("Shell completion not upgraded"),
      "Shell completion",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("is not writable"),
      "Shell completion",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("completion --install"),
      "Shell completion",
    );
  });

  it("re-throws non-permission errors from installCompletion", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-home-non-eacces-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-state-non-eacces-"));
    tempDirs.push(homeDir, stateDir);
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/bash");

    const bashrcPath = path.join(homeDir, ".bashrc");
    await fs.writeFile(
      bashrcPath,
      '# test bashrc\n[ -f "/tmp/nonexistent" ] && source <(openclaw completion bash)\n',
      "utf-8",
    );

    const cacheDir = path.join(stateDir, "completions");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "openclaw.bash"), "# completion cache\n", "utf-8");

    const enospcError = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
    enospcError.code = "ENOSPC";
    installCompletionMock.mockRejectedValue(enospcError);

    await expect(
      doctorShellCompletion({} as never, {
        confirm: async () => true,
      }),
    ).rejects.toThrow("ENOSPC");
  });
});
