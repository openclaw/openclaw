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
import { makePrompter } from "./doctor-auth-flat-profiles.test-support.js";
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

function setupBashHome() {
  const homeDir = tempDirs.make("openclaw-doctor-home-");
  const stateDir = tempDirs.make("openclaw-doctor-state-");
  setTestEnvValue("HOME", homeDir);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("SHELL", "/bin/bash");
  return { homeDir, stateDir };
}

describe("shell completion health mapping", () => {
  it("reports slow dynamic Bash completion from the documented login profile", async () => {
    const { homeDir, stateDir } = setupBashHome();

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

  it.each([
    {
      name: "slow dynamic completion",
      usesSlowPattern: true,
      finding: { checkId: "core/doctor/shell-completion", path: "shellCompletion.zsh" },
      effects: [
        completionEffect("would-generate-completion-cache"),
        completionEffect("would-upgrade-shell-profile-completion", "file", "zsh"),
      ],
    },
    {
      name: "missing cache",
      usesSlowPattern: false,
      finding: {
        message: expect.stringContaining("cache is missing"),
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      },
      effects: [completionEffect("would-regenerate-completion-cache")],
    },
  ])("reports $name with dry-run effects", ({ usesSlowPattern, finding, effects }) => {
    const current: ShellCompletionStatus = {
      shell: "zsh",
      profileInstalled: true,
      cacheExists: false,
      cachePath: "/tmp/openclaw.zsh",
      usesSlowPattern,
    };
    expect(shellCompletionStatusToHealthFindings(current)).toEqual([
      expect.objectContaining({ severity: "info", ...finding }),
    ]);
    expect(shellCompletionStatusToRepairEffects(current)).toEqual(effects);
  });
});

const installCompletionMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
vi.mock("../cli/completion-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/completion-runtime.js")>()),
  installCompletion: installCompletionMock,
}));

function expectCompletionNote(text: string) {
  expect(noteModule.note).toHaveBeenCalledWith(expect.stringContaining(text), "Shell completion");
}

async function setupDoctorCompletionTest(usesSlowPattern: boolean) {
  const { homeDir, stateDir } = setupBashHome();

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
    vi.spyOn(noteModule, "note");
  });

  it("shows the Bash login profile after installing completion without .bashrc", async () => {
    await setupDoctorCompletionTest(false);
    installCompletionMock.mockResolvedValue(undefined);
    await doctorShellCompletion(makePrompter(true));

    expect(installCompletionMock).toHaveBeenCalledWith("bash", true, "openclaw");
    expectCompletionNote("source ~/.bash_profile");
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
        ensureCompletionCacheExists("openclaw", { shell: "powershell", generationMode }),
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
    await expect(doctorShellCompletion(makePrompter(true))).resolves.not.toThrow();

    const command = formatCompletionReloadCommand(
      "bash",
      resolveCompletionCachePath("bash", "openclaw"),
    );
    expectCompletionNote(command);
    expectCompletionNote("session only");
    expectCompletionNote(failedPath);
  });

  it("re-throws non-permission errors from installCompletion", async () => {
    const profilePath = await setupDoctorCompletionTest(true);
    installCompletionMock.mockRejectedValue(wrappedFsError("ENOSPC", profilePath));

    await expect(doctorShellCompletion(makePrompter(true))).rejects.toThrow("ENOSPC");
  });
});
