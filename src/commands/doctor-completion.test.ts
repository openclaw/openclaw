import type { SpawnSyncOptions } from "node:child_process";
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
import { createDoctorPrompterFixture as makePrompter } from "../flows/doctor-health-context.test-support.js";
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

function completionEffect(action: string, kind = "state", target = "/tmp/openclaw.zsh") {
  return { kind, action, target, dryRunSafe: kind === "state" };
}

async function setupBashHome(usesSlowPattern = false) {
  const homeDir = tempDirs.make("openclaw-doctor-home-");
  const stateDir = tempDirs.make("openclaw-doctor-state-");
  setTestEnvValue("HOME", homeDir);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("SHELL", "/bin/bash");
  const profilePath = path.join(homeDir, usesSlowPattern ? ".bashrc" : ".bash_profile");
  if (usesSlowPattern) {
    await fs.writeFile(profilePath, '[ -f "/missing" ] && source <(openclaw completion bash)\n');
    const cacheDir = path.join(stateDir, "completions");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "openclaw.bash"), "# completion cache\n");
  }
  return { stateDir, profilePath };
}

describe("shell completion health mapping", () => {
  it("reports slow dynamic Bash completion from the documented login profile", async () => {
    const { profilePath, stateDir } = await setupBashHome();
    await fs.writeFile(profilePath, "source <(openclaw completion --shell bash)\n");

    const current = await checkShellCompletionStatus("openclaw", { shell: "bash" });
    expect(current.profileInstalled).toBe(true);
    expect(shellCompletionStatusToHealthFindings(current)).toEqual([
      expect.objectContaining({
        severity: "info",
        checkId: "core/doctor/shell-completion",
        path: "shellCompletion.bash",
      }),
    ]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual([
      completionEffect(
        "would-generate-completion-cache",
        "state",
        path.join(stateDir, "completions", "openclaw.bash"),
      ),
      completionEffect("would-upgrade-shell-profile-completion", "file", "bash"),
    ]);
  });

  it("reports a missing cache with a regeneration effect", () => {
    const current: ShellCompletionStatus = {
      shell: "zsh",
      profileInstalled: true,
      cacheExists: false,
      cachePath: "/tmp/openclaw.zsh",
      usesSlowPattern: false,
    };
    expect(shellCompletionStatusToHealthFindings(current)).toEqual([
      expect.objectContaining({
        severity: "info",
        message: expect.stringContaining("cache is missing"),
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    ]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual([
      completionEffect("would-regenerate-completion-cache"),
    ]);
  });
});

const installCompletionMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() =>
  vi.fn((_command: string, _args: string[], _options: SpawnSyncOptions) => ({ status: 0 })),
);
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
vi.mock("../cli/completion-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/completion-runtime.js")>()),
  installCompletion: installCompletionMock,
}));

function expectCompletionNote(text: string) {
  expect(noteModule.note).toHaveBeenCalledWith(expect.stringContaining(text), "Shell completion");
}

function wrappedFsError(code: string, profilePath: string): Error {
  const cause = Object.assign(new Error(code), { code, path: profilePath });
  return new Error(`Failed to install completion: ${cause.message}`, { cause });
}

describe("doctorShellCompletion", () => {
  beforeEach(() => {
    installCompletionMock.mockReset();
    spawnSyncMock.mockClear();
    vi.spyOn(noteModule, "note");
  });

  it("shows the Bash login profile after installing completion without .bashrc", async () => {
    await setupBashHome();
    await doctorShellCompletion(makePrompter(true, true));

    expectCompletionNote("source ~/.bash_profile");
  });

  it.each([
    ["full", undefined, "node"],
    ["core-only", "1", "bun"],
  ] as const)(
    "uses explicit %s cache generation (skip=%s, runtime=%s) with an ambient skip guard",
    async (generationMode, expectedSkipValue, runtime) => {
      Object.defineProperty(process, "versions", {
        value: { ...process.versions, bun: runtime === "bun" ? "1.4.3" : undefined },
      });
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-doctor-state-"));
      setTestEnvValue(COMPLETION_SKIP_PLUGIN_COMMANDS_ENV, "1");

      await expect(
        ensureCompletionCacheExists("openclaw", { shell: "powershell", generationMode }),
      ).resolves.toBe(true);

      const args = spawnSyncMock.mock.lastCall?.[1] ?? [];
      expect(args).toEqual(
        expect.arrayContaining(["completion", "--write-state", "--shell", "powershell"]),
      );
      const entryIndex = args.findIndex((arg) => arg.endsWith("openclaw.mjs"));
      expect(args.slice(0, entryIndex)).toEqual(runtime === "bun" ? ["--no-install"] : []);
      const spawnOptions = spawnSyncMock.mock.lastCall?.[2];
      expect(spawnOptions?.env?.[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]).toBe(expectedSkipValue);
    },
  );

  it("offers session recovery when completion is not installed after EPERM", async () => {
    const { profilePath } = await setupBashHome();
    const failedPath = path.dirname(profilePath);
    installCompletionMock.mockRejectedValue(wrappedFsError("EPERM", failedPath));
    await expect(doctorShellCompletion(makePrompter(true, true))).resolves.not.toThrow();

    const command = formatCompletionReloadCommand(
      "bash",
      resolveCompletionCachePath("bash", "openclaw"),
    );
    expectCompletionNote(command);
    expectCompletionNote("session only");
    expectCompletionNote(failedPath);
  });

  it("re-throws non-permission errors from installCompletion", async () => {
    const { profilePath } = await setupBashHome(true);
    installCompletionMock.mockRejectedValue(wrappedFsError("ENOSPC", profilePath));

    await expect(doctorShellCompletion(makePrompter(true, true))).rejects.toThrow("ENOSPC");
  });
});
