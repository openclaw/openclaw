import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  type CompletionShell,
  formatCompletionReloadCommand,
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfileHint,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
  usesSlowDynamicCompletion,
} from "./completion-runtime.js";

type PublishOutputFileAtomically =
  typeof import("./output-file.runtime.js").publishOutputFileAtomically;

const outputFileMocks = vi.hoisted(() => ({
  publishOutputFileAtomically: vi.fn<PublishOutputFileAtomically>(),
}));

vi.mock("./output-file.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
    "./output-file.runtime.js",
  );
  outputFileMocks.publishOutputFileAtomically.mockImplementation(
    actual.publishOutputFileAtomically,
  );
  return {
    ...actual,
    publishOutputFileAtomically: outputFileMocks.publishOutputFileAtomically,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const windowsShells = {
  core: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  legacy: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
};

const withCompletionEnv = (homeDir: string, stateDir: string, run: () => Promise<void>) =>
  withEnvAsync(
    {
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: undefined,
      ZDOTDIR: undefined,
    },
    run,
  );

async function withCompletionHome(
  run: (paths: { homeDir: string; stateDir: string }) => Promise<void>,
  stateDirPrefix = "openclaw-bash-completion-state-",
  portable = false,
): Promise<void> {
  const homeDir = tempDirs.make("openclaw-bash-completion-home-");
  const stateDir = portable ? path.join(homeDir, ".openclaw") : tempDirs.make(stateDirPrefix);

  await withCompletionEnv(homeDir, stateDir, () => run({ homeDir, stateDir }));
}

async function writeCompletionCache(shell: CompletionShell, content = "# completion\n") {
  const cachePath = resolveCompletionCachePath(shell, "openclaw");
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, content, "utf8");
  return cachePath;
}

const readProfile = (profilePath: string) => fs.readFile(profilePath, "utf8");

it.skipIf(process.platform === "win32")(
  "escapes terminal controls in installation messages without changing profile paths",
  async () => {
    await withCompletionHome(async ({ homeDir }) => {
      const profileDir = path.join(
        homeDir,
        "profiles-café\u001b[31m\noperator-forged\tend\rrow\u0007",
      );
      await withEnvAsync({ ZDOTDIR: profileDir }, async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const cachePath = await writeCompletionCache("zsh");

        await installCompletion("zsh", false);
        const profilePath = path.join(profileDir, ".zshrc");
        const installed = await readProfile(profilePath);
        expect(installed).toContain(cachePath);
        await installCompletion("zsh", false);
        expect(await readProfile(profilePath)).toBe(installed);

        const messages = [...warn.mock.calls, ...log.mock.calls].map((args) => args.join(" "));
        expect(messages.some((message) => message.includes("Profile not found"))).toBe(true);
        expect(messages.some((message) => message.includes("Installing completion"))).toBe(true);
        expect(messages).toContain("Completion installed. Restart your shell to load it.");
        expect(messages.some((message) => message.includes("already installed"))).toBe(true);
        for (const message of messages) {
          expect(message).not.toMatch(/\p{Cc}/u);
        }
        expect(messages.join("\n")).toContain("profiles-café\\noperator-forged\\tend\\rrow");
      });
    });
  },
);

it.skipIf(process.platform === "win32")("rejects a special-device profile target", async () => {
  await withCompletionHome(async ({ homeDir }) => {
    await fs.symlink("/dev/null", path.join(homeDir, ".zshrc"));
    await expect(isCompletionInstalled("zsh")).rejects.toThrow(/regular file/);
  });
});

it.skipIf(process.platform === "win32")("rejects a FIFO profile without replacing it", async () => {
  await withCompletionHome(async ({ homeDir }) => {
    await writeCompletionCache("zsh");
    const profilePath = path.join(homeDir, ".zshrc");
    execFileSync("mkfifo", [profilePath]);
    await expect(isCompletionInstalled("zsh")).rejects.toThrow(/regular file/);
    await expect(usesSlowDynamicCompletion("zsh")).rejects.toThrow(/regular file/);
    await expect(installCompletion("zsh", true)).rejects.toThrow(/regular file/);
    expect((await fs.lstat(profilePath)).isFIFO()).toBe(true);
  });
});

function expectProfileMode(profilePath: string) {
  return process.platform === "win32"
    ? Promise.resolve()
    : fs.stat(profilePath).then((stat) => expect(stat.mode & 0o777).toBe(0o640));
}

async function writeProfile(shell: CompletionShell, content: string) {
  const profilePath = resolveCompletionProfilePath(shell);
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await fs.writeFile(profilePath, content, "utf8");
  return profilePath;
}

function expectAvailableZshToSucceed(result: SpawnSyncReturns<string>): void {
  if (result.error) {
    if (
      "code" in result.error &&
      (result.error.code === "ENOENT" || result.error.code === "EACCES")
    ) {
      return;
    }
    throw result.error;
  }
  expect(result).toMatchObject({ stderr: "", status: 0 });
}

it("preserves zsh's set-but-empty startup directory contract", () => {
  vi.stubEnv("HOME", "/tmp/openclaw-home");
  vi.stubEnv("ZDOTDIR", "");
  expect(resolveCompletionProfilePath("zsh")).toBe(path.join(path.sep, ".zshrc"));
});

it.skipIf(process.platform === "win32")(
  "preserves Zsh and Fish symlink traversal before parent path components",
  async () => {
    for (const [shell, variable, profileName] of [
      ["zsh", "ZDOTDIR", ".zshrc"],
      ["fish", "XDG_CONFIG_HOME", path.join("fish", "config.fish")],
    ] as const) {
      await withCompletionHome(async ({ homeDir }) => {
        const profileParent = tempDirs.make(`openclaw-${shell}-symlink-profiles-`);
        const nestedProfiles = path.join(profileParent, "nested");
        const linkedProfiles = path.join(homeDir, "linked-profiles");
        await fs.mkdir(nestedProfiles, { recursive: true });
        await fs.symlink(nestedProfiles, linkedProfiles, "dir");

        await withEnvAsync({ [variable]: `${linkedProfiles}${path.sep}..` }, async () => {
          const cachePath = await writeCompletionCache(shell, "OPENCLAW_COMPLETION_LOADED=ready\n");
          await installCompletion(shell, true, "openclaw");
          await expect(readProfile(path.join(profileParent, profileName))).resolves.toContain(
            cachePath,
          );
          expect(resolveCompletionProfileHint(shell)).toBe(
            `~${path.sep}linked-profiles${path.sep}..${path.sep}${profileName}`,
          );
        });
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves every shell's default profile traversal through a symlinked HOME",
  async () => {
    const fixtureRoot = tempDirs.make("openclaw-completion-home-symlink-");
    const realHome = path.join(fixtureRoot, "real-home");
    const nestedHome = path.join(realHome, "nested");
    const linkedHome = path.join(fixtureRoot, "linked-home");
    await fs.mkdir(nestedHome, { recursive: true });
    await fs.symlink(nestedHome, linkedHome, "dir");

    for (const [shell, profileName] of [
      ["zsh", ".zshrc"],
      ["bash", ".bash_profile"],
      ["fish", path.join(".config", "fish", "config.fish")],
      ["powershell", path.join(".config", "powershell", "Microsoft.PowerShell_profile.ps1")],
    ] as const) {
      const stateDir = tempDirs.make(`openclaw-${shell}-home-symlink-state-`);
      await withCompletionEnv(`${linkedHome}${path.sep}..`, stateDir, async () => {
        const cachePath = await writeCompletionCache(shell, `# cached ${shell} completion\n`);
        await installCompletion(shell, true, "openclaw");
        await expect(readProfile(path.join(realHome, profileName))).resolves.toContain(cachePath);
        expect(resolveCompletionProfileHint(shell)).toBe(
          shell === "powershell"
            ? `${linkedHome}${path.sep}..${path.sep}${profileName}`
            : `~/${profileName}`,
        );
      });
    }
  },
);

it.each(["~/literal startup", "../startup"])(
  "keeps relative Zsh profile hints literal: %s",
  async (profileRoot) => {
    await withEnvAsync({ HOME: "/tmp/openclaw-home", ZDOTDIR: profileRoot }, async () => {
      const profilePath = path.join(profileRoot, ".zshrc");
      const expected = profilePath.startsWith(`..${path.sep}`)
        ? profilePath
        : `.${path.sep}${profilePath}`;
      expect(resolveCompletionProfileHint("zsh")).toBe(expected);
    });
  },
);

it("loads cached Bash completion from a literal path through the login profile", async () => {
  await withCompletionHome(async () => {
    await writeCompletionCache("bash", "complete -W 'status' openclaw\n");

    const profilePath = await writeProfile("bash", "export COMPLETION_PROOF=value\\ \n");
    await installCompletion("bash", true, "openclaw");

    await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
    await expect(usesSlowDynamicCompletion("bash", "openclaw")).resolves.toBe(false);

    const shell = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'source "$1"; complete -p openclaw; printf "<%s>\\n" "$COMPLETION_PROOF"',
        "openclaw",
        profilePath,
      ],
      { encoding: "utf8" },
    );
    expect(shell).toMatchObject({ stderr: "", status: 0 });
    expect(shell.stdout).toContain("complete -W 'status' openclaw");
    expect(shell.stdout).toContain("<value >\n");
  }, "openclaw-completion-literal$dollar Ada's !42-");
});

it("preserves an existing profile when atomic publication fails", async () => {
  await withCompletionHome(async ({ homeDir }) => {
    await writeCompletionCache("zsh", "# completion\n");
    const profilePath = await writeProfile("zsh", "export IMPORTANT=keep\n");
    await fs.chmod(profilePath, 0o640);
    const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
      "./output-file.runtime.js",
    );
    outputFileMocks.publishOutputFileAtomically.mockImplementationOnce(async (params) => {
      return await actual.publishOutputFileAtomically({
        ...params,
        writeTemp: async (tempPath) => {
          await params.writeTemp(tempPath);
          await fs.truncate(tempPath, 1);
          throw new Error("injected completion profile write failure");
        },
      });
    });

    await expect(installCompletion("zsh", true, "openclaw")).rejects.toThrow(
      "Failed to install completion: injected completion profile write failure",
    );

    await expect(readProfile(profilePath)).resolves.toBe("export IMPORTANT=keep\n");
    await expectProfileMode(profilePath);
    expect(await fs.readdir(homeDir)).toEqual([".zshrc"]);
  });
});

it.skipIf(process.platform === "win32").each([false, true])(
  "preserves a profile symlink while writing its target (dangling=%s)",
  async (dangling) => {
    await withCompletionHome(async ({ homeDir }) => {
      const cachePath = await writeCompletionCache("zsh");
      const targetDir = dangling
        ? path.join(homeDir, "managed")
        : tempDirs.make("completion-target-");
      const targetPath = path.join(targetDir, "zshrc");
      const profilePath = path.join(homeDir, ".zshrc");
      await fs.mkdir(targetDir, { recursive: true });
      if (!dangling) {
        await fs.writeFile(targetPath, "export IMPORTANT=keep\n", "utf8");
      }
      await fs.symlink(dangling ? path.join("managed", "zshrc") : targetPath, profilePath);
      await installCompletion("zsh", true, "openclaw");
      expect((await fs.lstat(profilePath)).isSymbolicLink()).toBe(true);
      const profile = await readProfile(targetPath);
      if (dangling) {
        expect(await fs.readlink(profilePath)).toBe(path.join("managed", "zshrc"));
        expect(profile).toContain("# OpenClaw Completion");
      } else {
        expect(profile).toContain("export IMPORTANT=keep\n");
        expect(profile).toContain(cachePath);
      }
    });
  },
);

it("recognizes an installed profile when its completion cache has been removed", async () => {
  await withCompletionHome(async ({ homeDir }) => {
    const cachePath = resolveCompletionCachePath("bash", "openclaw");
    await fs.writeFile(
      path.join(homeDir, ".bash_profile"),
      `# OpenClaw Completion\n[ -f "${cachePath}" ] && source "${cachePath}"\n`,
      "utf-8",
    );

    await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
  });
});

it("replaces the current fish source after the literal state directory changes", async () => {
  const shell = "fish";
  await withCompletionHome(async () => {
    const previousStateDir = tempDirs.make(
      `openclaw-completion-previous-${process.platform === "win32" ? "" : '"'}$state's ‘quoted’-`,
    );
    const profilePath = resolveCompletionProfilePath(shell);
    await withEnvAsync({ OPENCLAW_STATE_DIR: previousStateDir }, async () => {
      await writeCompletionCache(shell, "# previous completion\n");
      await installCompletion(shell, true, "openclaw");
    });
    const previousSource = (await readProfile(profilePath)).trim().split("\n").at(-1)!;

    await writeCompletionCache(shell, "# current completion\n");
    await installCompletion(shell, true, "openclaw");

    const profile = await readProfile(profilePath);
    expect(profile).not.toContain(previousSource);
    expect(profile.match(/^# OpenClaw Completion$/gm)).toHaveLength(1);
    await expect(isCompletionInstalled(shell, "openclaw")).resolves.toBe(true);
    await installCompletion(shell, true, "openclaw");
    await expect(readProfile(profilePath)).resolves.toBe(profile);
  }, "openclaw-completion-current-$state's-");
});

it("preserves unrelated generated-looking sources that are not owned by its profile marker", async () => {
  await withCompletionHome(async ({ homeDir }) => {
    const cachePath = await writeCompletionCache("bash", "# current completion\n");
    const profilePath = path.join(homeDir, ".bash_profile");
    const unrelatedSource = 'source "/opt/tools/completions/openclaw.zsh"';
    const unmarkedPriorSource = 'source "/opt/tools/completions/openclaw.bash"';
    const markedUserSources = [
      "source '/opt/tools/not-completions/openclaw.bash'",
      "source '/opt/tools/completions/openclaw.zsh'",
      "[ -f '/other/completions/openclaw.bash' ] && source '/opt/tools/completions/openclaw.bash'",
      '[ -f "/opt/tools/completions/openclaw.bash" ] && source "/opt/tools/completions/openclaw.bash"; export IMPORTANT=keep',
      "source '/opt/tools/completions/openclaw.bash'; export IMPORTANT=keep",
      'source "/old/completions/openclaw.bash"; printf "%s" "/other/completions/openclaw.bash"',
      "source '/opt/tools/completions/openclaw.bash",
      '. "/opt/tools/completions/openclaw.bash"',
    ];
    await fs.writeFile(
      profilePath,
      [
        unrelatedSource,
        unmarkedPriorSource,
        ...markedUserSources.flatMap((source) => ["# OpenClaw Completion", source]),
        "",
      ].join("\n"),
      "utf-8",
    );

    await installCompletion("bash", true, "openclaw");

    const profile = await readProfile(profilePath);
    for (const source of [unrelatedSource, unmarkedPriorSource, ...markedUserSources]) {
      expect(profile).toContain(`${source}\n`);
    }
    expect(profile).toContain(cachePath);
  });
});

it.each([
  ["bash", undefined, 'source <(openclaw completion --shell bash >"$HOME/completion.log")'],
  [
    "bash",
    'eval "$(openclaw completion --shell bash)"',
    "alias refresh_openclaw='openclaw completion --write-state'",
  ],
  [
    "powershell",
    "openclaw completion --shell powershell | Out-String | Invoke-Expression",
    '$refresh = "openclaw completion --write-state"',
  ],
] as const)(
  "migrates %s completion without deleting user commands: %s",
  async (shell, replaced, retained) => {
    await withCompletionHome(async () => {
      const cachePath = await writeCompletionCache(shell);
      const profilePath = await writeProfile(
        shell,
        [replaced, retained, ""].filter((line) => line !== undefined).join("\n"),
      );
      if (shell === "powershell") {
        await expect(usesSlowDynamicCompletion(shell, "openclaw")).resolves.toBe(true);
      }
      await installCompletion(shell, true, "openclaw");
      const profile = await readProfile(profilePath);
      expect(profile).toContain(retained + "\n");
      if (replaced) {
        expect(profile).not.toContain(replaced);
        expect(profile).toContain(cachePath);
      } else {
        await expect(isCompletionInstalled(shell, "openclaw")).resolves.toBe(true);
      }
    });
  },
);

it.each([
  ["powershell", "C:\\Users\\Ada\\profile.ps1", ". 'C:\\Users\\Ada\\profile.ps1'"],
  ["bash", "~/Ada's !42 profile/.shellrc", "source ~/'Ada'\\''s !42 profile/.shellrc'"],
] as const)("quotes literal %s reload paths with native expansion", (shell, profile, expected) => {
  expect(formatCompletionReloadCommand(shell, profile)).toBe(expected);
});

it("reloads a zsh profile when its absolute path contains spaces", async () => {
  const profileDir = tempDirs.make("openclaw zsh Ada's !42 reload profile-");
  const profilePath = path.join(profileDir, ".shellrc");
  await fs.writeFile(profilePath, "OPENCLAW_COMPLETION_LOADED=ready\n", "utf-8");

  const reloadCommand = formatCompletionReloadCommand("zsh", profilePath);
  expect(reloadCommand).toBe(`source '${profilePath.replaceAll("'", "'\\''")}'`);
  const shell = spawnSync(
    "zsh",
    ["-c", `${reloadCommand}; [ "$OPENCLAW_COMPLETION_LOADED" = ready ]`],
    {
      encoding: "utf8",
    },
  );
  expectAvailableZshToSucceed(shell);
});

it.each([
  ["unknown Windows shell", { SHELL: "C:\\Windows\\System32\\cmd.exe" }, "win32", "powershell"],
  ["PowerShell Core", { SHELL: windowsShells.core }, "win32", "powershell"],
  ["Windows PowerShell", { SHELL: windowsShells.legacy }, "win32", "powershell"],
  ["non-Windows without SHELL", {}, "linux", "zsh"],
] as const)("detects %s", (_name, env, platform, expected) => {
  vi.stubEnv("SHELL", "SHELL" in env ? env.SHELL : undefined);
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  expect(resolveShellFromEnv()).toBe(expected);
});

it("resolves Windows PowerShell and pwsh profile directories", () => {
  const home = "C:\\Users\\Ada";
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("HOME", undefined);
  vi.stubEnv("USERPROFILE", home);
  const resolve = (shell: string) => {
    vi.stubEnv("SHELL", shell);
    return resolveCompletionProfilePath("powershell");
  };
  const profile = (directory: string) =>
    path.win32.join(home, "Documents", directory, "Microsoft.PowerShell_profile.ps1");
  expect(resolve(windowsShells.core)).toBe(profile("PowerShell"));
  expect(resolve(windowsShells.legacy)).toBe(profile("WindowsPowerShell"));
});

it("rejects install when the completion cache is missing", async () => {
  await withCompletionHome(async () => {
    await expect(installCompletion("zsh", true, "openclaw")).rejects.toThrow(
      "Completion cache not found",
    );
  });
});

it.skipIf(process.platform === "win32").each([
  [
    "bash",
    '# OpenClaw Completion\n[[ -f "${HOME}/.openclaw/completions/openclaw.bash" ]] && source "${HOME}/.openclaw/completions/openclaw.bash"',
    true,
  ],
  [
    "fish",
    'test -f "$HOME/.openclaw/completions/openclaw.fish"; and source "$HOME/.openclaw/completions/openclaw.fish"',
    true,
  ],
  [
    "bash",
    '# OpenClaw Completion\n[ -f "$HOME/.other/completions/openclaw.bash" ] && source "$HOME/.other/completions/openclaw.bash"',
    false,
  ],
] as const)("preserves %s hook %s (recognized=%s)", async (shell, hook, recognized) => {
  await withCompletionHome(
    async ({ homeDir, stateDir }) => {
      const profilePath = path.join(
        homeDir,
        shell === "bash" ? ".bashrc" : ".config/fish/config.fish",
      );
      const cachePath = await writeCompletionCache(
        shell,
        shell === "bash"
          ? "complete -W 'completion doctor' openclaw\n"
          : "# cached fish completion\n",
      );
      if (shell === "bash" && recognized) {
        expect(cachePath).toBe(path.join(stateDir, "completions", "openclaw.bash"));
      }
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, hook + "\n", "utf8");
      await expect(isCompletionInstalled(shell, "openclaw")).resolves.toBe(recognized);
      await installCompletion(shell, true, "openclaw");
      const first = await readProfile(profilePath);
      if (recognized) {
        expect(first).toBe(hook + "\n");
      } else {
        expect(first).toContain(hook.split("\n")[1] + "\n");
        expect(first).toContain("# OpenClaw Completion");
        expect(first).toContain(cachePath);
        await expect(isCompletionInstalled(shell, "openclaw")).resolves.toBe(true);
      }
      await installCompletion(shell, true, "openclaw");
      await expect(readProfile(profilePath)).resolves.toBe(first);
      if (shell === "bash" && recognized) {
        const freshBash = spawnSync(
          "bash",
          ["-c", `source "${profilePath}" && complete -p openclaw`],
          { encoding: "utf8" },
        );
        expect(freshBash).toMatchObject({ stderr: "", status: 0 });
        expect(freshBash.stdout).toContain("openclaw");
      }
    },
    undefined,
    true,
  );
});
