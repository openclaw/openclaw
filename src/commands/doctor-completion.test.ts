// Doctor completion tests cover final doctor status summaries and completion messaging.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV,
  formatCompletionReloadCommand,
  resolveCompletionCachePath,
} from "../cli/completion-runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  checkShellCompletionStatus,
  doctorShellCompletion,
  ensureCompletionCacheExists,
  shellCompletionStatusToHealthFindings,
  shellCompletionStatusToRepairEffects,
  type ShellCompletionStatus,
} from "./doctor-completion.js";

const originalEnv = captureEnv([
  "HOME",
  "OPENCLAW_STATE_DIR",
  "SHELL",
  "XDG_CONFIG_HOME",
  "ZDOTDIR",
  COMPLETION_SKIP_PLUGIN_COMMANDS_ENV,
]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalVersions = process.versions;

afterEach(async () => {
  originalEnv.restore();
  Object.defineProperty(process, "versions", { value: originalVersions });
  vi.restoreAllMocks();
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
  it("reports slow dynamic Bash completion from the documented login profile", async () => {
    const homeDir = tempDirs.make("openclaw-bash-slow-profile-home-");
    const stateDir = tempDirs.make("openclaw-bash-slow-profile-state-");
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/bash");

    await fs.writeFile(
      path.join(homeDir, ".bash_profile"),
      "source <(openclaw completion --shell bash)\n",
      "utf-8",
    );

    await expect(checkShellCompletionStatus("openclaw", { shell: "bash" })).resolves.toEqual({
      shell: "bash",
      profileInstalled: true,
      cacheExists: false,
      cachePath: path.join(stateDir, "completions", "openclaw.bash"),
      usesSlowPattern: true,
    });
  });

  it("does not abort status checks when the shell profile is not valid UTF-8", async () => {
    const homeDir = tempDirs.make("openclaw-zsh-invalid-utf8-home-");
    const stateDir = tempDirs.make("openclaw-zsh-invalid-utf8-state-");
    setTestEnvValue("HOME", homeDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("SHELL", "/bin/zsh");
    setTestEnvValue("ZDOTDIR", homeDir);

    const cachePath = path.join(stateDir, "completions", "openclaw.zsh");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "# cached completion\n", "utf8");
    await fs.writeFile(
      path.join(homeDir, ".zshrc"),
      Buffer.concat([Buffer.from("export KEEP="), Buffer.from([0xff]), Buffer.from("\n")]),
    );

    await expect(checkShellCompletionStatus("openclaw", { shell: "zsh" })).resolves.toEqual({
      shell: "zsh",
      profileInstalled: false,
      cacheExists: true,
      cachePath,
      usesSlowPattern: false,
    });
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
});

const installCompletionMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
vi.mock("../cli/completion-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/completion-runtime.js")>();
  return {
    ...actual,
    installCompletion: installCompletionMock,
  };
});

function mockPrompter(confirmValue = true) {
  return {
    confirm: vi.fn(async () => confirmValue),
    confirmAutoFix: vi.fn(async () => confirmValue),
    confirmAggressiveAutoFix: vi.fn(async () => confirmValue),
    confirmRuntimeRepair: vi.fn(async () => confirmValue),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: true,
    shouldForce: false,
    repairMode: {
      shouldRepair: true,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  } as never;
}

async function setupDoctorCompletionTest(usesSlowPattern: boolean) {
  const homeDir = tempDirs.make("openclaw-doctor-home-");
  const stateDir = tempDirs.make("openclaw-doctor-state-");
  setTestEnvValue("HOME", homeDir);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("SHELL", "/bin/bash");

  const profilePath = path.join(homeDir, usesSlowPattern ? ".bashrc" : ".bash_profile");
  if (usesSlowPattern) {
    await fs.writeFile(
      profilePath,
      '# test bashrc\n[ -f "/tmp/nonexistent" ] && source <(openclaw completion bash)\n',
      "utf-8",
    );
    const cacheDir = path.join(stateDir, "completions");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "openclaw.bash"), "# completion cache\n", "utf-8");
  }
  return profilePath;
}

function wrappedFsError(code: string, profilePath: string): Error {
  const cause = Object.assign(new Error(`${code}: profile write failed`), {
    code,
    path: profilePath,
  });
  return new Error(`Failed to install completion: ${cause.message}`, { cause });
}

describe("doctorShellCompletion", () => {
  beforeEach(() => {
    installCompletionMock.mockReset();
    spawnSyncMock.mockClear();
  });

  it("shows the Bash login profile after installing completion without .bashrc", async () => {
    await setupDoctorCompletionTest(false);
    installCompletionMock.mockResolvedValue(undefined);
    const noteSpy = vi.spyOn(noteModule, "note");

    await doctorShellCompletion(mockPrompter());

    expect(installCompletionMock).toHaveBeenCalledWith("bash", true, "openclaw");
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("source ~/.bash_profile"),
      "Shell completion",
    );
  });

  it.each([
    { generationMode: "full" as const, expectedSkipValue: undefined, runtime: "node" },
    { generationMode: "core-only" as const, expectedSkipValue: "1", runtime: "bun" },
  ])(
    "uses explicit $generationMode cache generation on $runtime even with an ambient skip guard",
    async ({ generationMode, expectedSkipValue, runtime }) => {
      Object.defineProperty(process, "versions", {
        value: { ...process.versions, bun: runtime === "bun" ? "1.4.3" : undefined },
      });
      const stateDir = tempDirs.make("openclaw-doctor-state-");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue(COMPLETION_SKIP_PLUGIN_COMMANDS_ENV, "1");

      await expect(
        ensureCompletionCacheExists("openclaw", {
          shell: "powershell",
          generationMode,
        }),
      ).resolves.toBe(true);

      expect(spawnSyncMock).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(["completion", "--write-state", "--shell", "powershell"]),
        expect.any(Object),
      );
      const spawnCalls = spawnSyncMock.mock.calls as unknown as Array<
        [string, string[], { env?: NodeJS.ProcessEnv }]
      >;
      const args = spawnCalls.at(-1)?.[1] ?? [];
      const entryIndex = args.findIndex((arg) => arg.endsWith("openclaw.mjs"));
      expect(args.slice(0, entryIndex)).toEqual(runtime === "bun" ? ["--no-install"] : []);
      const spawnOptions = spawnCalls.at(-1)?.[2];
      expect(spawnOptions?.env?.[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]).toBe(expectedSkipValue);
    },
  );

  it("offers session recovery when completion is not installed after EPERM", async () => {
    const profilePath = await setupDoctorCompletionTest(false);
    const failedPath = path.dirname(profilePath);
    installCompletionMock.mockRejectedValue(wrappedFsError("EPERM", failedPath));
    const noteSpy = vi.spyOn(noteModule, "note");

    await expect(doctorShellCompletion(mockPrompter())).resolves.not.toThrow();

    const command = formatCompletionReloadCommand(
      "bash",
      resolveCompletionCachePath("bash", "openclaw"),
    );
    expect(noteSpy).toHaveBeenCalledWith(expect.stringContaining(command), "Shell completion");
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("session only"),
      "Shell completion",
    );
    expect(noteSpy).toHaveBeenCalledWith(expect.stringContaining(failedPath), "Shell completion");
  });

  it("re-throws non-permission errors from installCompletion", async () => {
    const profilePath = await setupDoctorCompletionTest(true);
    installCompletionMock.mockRejectedValue(wrappedFsError("ENOSPC", profilePath));

    await expect(doctorShellCompletion(mockPrompter())).rejects.toThrow("ENOSPC");
  });
});
