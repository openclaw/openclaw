// Completion runtime tests cover shell completion generation and runtime file writes.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  COMPLETION_SHELLS,
  formatCompletionReloadCommand,
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfileHint,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
  usesSlowDynamicCompletion,
} from "./completion-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const configuredShellCases = [
  {
    shell: "zsh" as const,
    envName: "ZDOTDIR" as const,
    profileSegments: [".zshrc"],
    cacheContent: "export OPENCLAW_TEST_COMPLETION_READY=zsh\n",
    startupArgs: ["-i", "-c", 'printf "%s" "$OPENCLAW_TEST_COMPLETION_READY"'],
  },
  {
    shell: "fish" as const,
    envName: "XDG_CONFIG_HOME" as const,
    profileSegments: ["fish", "config.fish"],
    cacheContent: "set -gx OPENCLAW_TEST_COMPLETION_READY fish\n",
    startupArgs: ["-c", 'printf "%s" "$OPENCLAW_TEST_COMPLETION_READY"'],
  },
] as const;

async function withBashCompletionHome(
  run: (paths: { homeDir: string; stateDir: string }) => Promise<void>,
): Promise<void> {
  const homeDir = tempDirs.make("openclaw-bash-completion-home-");
  const stateDir = tempDirs.make("openclaw-bash-completion-state-");

  await withEnvAsync({ HOME: homeDir, OPENCLAW_STATE_DIR: stateDir }, async () => {
    await run({ homeDir, stateDir });
  });
}

describe("completion-runtime", () => {
  it("preserves the root startup profile for an explicitly empty ZDOTDIR", () => {
    const homeDir = path.join(os.tmpdir(), "openclaw-empty-zdotdir-home");

    expect(
      resolveCompletionProfilePath("zsh", {
        env: { HOME: homeDir, ZDOTDIR: "" },
        homeDir: () => homeDir,
      }),
    ).toBe(path.join(path.parse(homeDir).root, ".zshrc"));
  });

  it.each(configuredShellCases)(
    "resolves the actual $shell startup profile from $envName",
    ({ shell, envName, profileSegments }) => {
      const homeDir = path.join(os.tmpdir(), "openclaw-shell-profile-home");
      const configuredRoot = path.join(os.tmpdir(), "openclaw-shell-profile-config");

      expect(
        resolveCompletionProfilePath(shell, {
          env: { HOME: homeDir, [envName]: configuredRoot },
          homeDir: () => homeDir,
        }),
      ).toBe(path.join(configuredRoot, ...profileSegments));
    },
  );

  it.each([
    "relative-config",
    "../relative-config",
    " relative-config ",
    "   ",
    "~/relative-config",
    "~root/relative-config",
    "-relative-config",
    "+relative-config",
  ])("preserves Fish's verbatim nonempty XDG_CONFIG_HOME when it is %s", (configuredRoot) => {
    const homeDir = path.join(os.tmpdir(), "openclaw-fish-relative-xdg-home");

    expect(
      resolveCompletionProfilePath("fish", {
        env: { HOME: homeDir, XDG_CONFIG_HOME: configuredRoot },
        homeDir: () => homeDir,
      }),
    ).toBe(path.join(configuredRoot, "fish", "config.fish"));
  });

  it.each([
    {
      shell: "zsh" as const,
      env: { HOME: "/Users/ada", ZDOTDIR: "/Users/ada/.config/zsh dotfiles" },
      expected: "~/.config/zsh dotfiles/.zshrc",
    },
    {
      shell: "fish" as const,
      env: { HOME: "/Users/ada", XDG_CONFIG_HOME: "/Users/ada/custom xdg" },
      expected: "~/custom xdg/fish/config.fish",
    },
    {
      shell: "fish" as const,
      env: { HOME: "/Users/ada", XDG_CONFIG_HOME: "~/literal-config" },
      expected: "./~/literal-config/fish/config.fish",
    },
    {
      shell: "zsh" as const,
      env: { HOME: "/Users/ada", ZDOTDIR: "/tmp/configured zsh" },
      expected: "/tmp/configured zsh/.zshrc",
    },
  ])("formats the canonical $shell profile hint without hiding configured roots", (testCase) => {
    expect(resolveCompletionProfileHint(testCase.shell, { env: testCase.env })).toBe(
      testCase.expected,
    );
  });

  it.each(configuredShellCases)(
    "installs cached $shell completion into its configured startup profile",
    async ({ shell, envName, profileSegments, cacheContent, startupArgs }) => {
      const tempDir = tempDirs.make(`openclaw-${shell}-configured-profile-`);
      const homeDir = path.join(tempDir, "home");
      const stateDir = path.join(tempDir, "state");
      const configuredRoot = path.join(tempDir, "configured startup");
      const profilePath = path.join(configuredRoot, ...profileSegments);
      await fs.mkdir(homeDir, { recursive: true });

      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
          ZDOTDIR: envName === "ZDOTDIR" ? configuredRoot : undefined,
          XDG_CONFIG_HOME: envName === "XDG_CONFIG_HOME" ? configuredRoot : undefined,
          OPENCLAW_TEST_COMPLETION_READY: undefined,
        },
        async () => {
          const cachePath = resolveCompletionCachePath(shell, "openclaw");
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, cacheContent, "utf-8");

          await installCompletion(shell, true, "openclaw");

          await expect(fs.readFile(profilePath, "utf-8")).resolves.toContain(cachePath);
          await expect(isCompletionInstalled(shell, "openclaw")).resolves.toBe(true);

          const shellVersion = spawnSync(shell, ["--version"], { encoding: "utf8" });
          if (shellVersion.error) {
            return;
          }

          const actualShell = spawnSync(shell, [...startupArgs], {
            encoding: "utf8",
            env: process.env,
          });
          expect(actualShell.status).toBe(0);
          expect(actualShell.stdout).toBe(shell);
        },
      );
    },
  );

  it.each(configuredShellCases)(
    "preserves symlink traversal in the configured $shell startup root",
    async ({ shell, envName, profileSegments, cacheContent, startupArgs }) => {
      const shellVersion = spawnSync(shell, ["--version"], { encoding: "utf8" });
      if (shellVersion.error || process.platform === "win32") {
        return;
      }

      const tempDir = tempDirs.make(`openclaw-${shell}-symlink-startup-`);
      const homeDir = path.join(tempDir, "home");
      const stateDir = path.join(tempDir, "state");
      const actualRoot = path.join(tempDir, "actual startup");
      const symlinkTarget = path.join(actualRoot, "nested");
      const link = path.join(homeDir, "linked startup");
      const configuredRoot = `${link}${path.sep}..`;
      const profileSuffix = profileSegments.join(path.sep);
      const lexicalProfile = `${configuredRoot}${path.sep}${profileSuffix}`;
      const actualProfile = path.join(actualRoot, ...profileSegments);
      await fs.mkdir(homeDir, { recursive: true });
      await fs.mkdir(symlinkTarget, { recursive: true });
      await fs.symlink(symlinkTarget, link, "dir");

      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
          ZDOTDIR: envName === "ZDOTDIR" ? configuredRoot : undefined,
          XDG_CONFIG_HOME: envName === "XDG_CONFIG_HOME" ? configuredRoot : undefined,
          OPENCLAW_TEST_COMPLETION_READY: undefined,
        },
        async () => {
          const cachePath = resolveCompletionCachePath(shell, "openclaw");
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, cacheContent, "utf8");

          expect(resolveCompletionProfilePath(shell)).toBe(lexicalProfile);
          expect(resolveCompletionProfileHint(shell)).toBe(
            `~/linked startup/../${profileSegments.join("/")}`,
          );
          await installCompletion(shell, true, "openclaw");
          await expect(fs.readFile(actualProfile, "utf8")).resolves.toContain(cachePath);
          await expect(isCompletionInstalled(shell, "openclaw")).resolves.toBe(true);

          const actualShell = spawnSync(shell, [...startupArgs], {
            encoding: "utf8",
            env: process.env,
          });
          expect(actualShell.status).toBe(0);
          expect(actualShell.stdout).toBe(shell);
        },
      );
    },
  );

  it.each([
    { mode: "relative", directory: "relative startup" },
    { mode: "space-padded", directory: " relative startup " },
  ])("activates actual Fish startup for a $mode XDG_CONFIG_HOME", async (testCase) => {
    const fishVersion = spawnSync("fish", ["--version"], { encoding: "utf8" });
    if (fishVersion.error) {
      return;
    }

    const tempDir = tempDirs.make(`openclaw-fish-${testCase.mode}-xdg-`);
    const homeDir = path.join(tempDir, "home");
    const stateDir = path.join(tempDir, "state");
    const configuredRoot = path.relative(process.cwd(), path.join(tempDir, testCase.directory));
    const profilePath = path.join(configuredRoot, "fish", "config.fish");
    await fs.mkdir(homeDir, { recursive: true });

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        XDG_CONFIG_HOME: configuredRoot,
        OPENCLAW_TEST_COMPLETION_READY: undefined,
      },
      async () => {
        const cachePath = resolveCompletionCachePath("fish", "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "set -gx OPENCLAW_TEST_COMPLETION_READY relative-fish\n");

        expect(path.isAbsolute(configuredRoot)).toBe(false);
        expect(resolveCompletionProfilePath("fish")).toBe(profilePath);
        await installCompletion("fish", true, "openclaw");
        await expect(fs.readFile(profilePath, "utf8")).resolves.toContain(cachePath);
        await expect(isCompletionInstalled("fish", "openclaw")).resolves.toBe(true);

        const actualShell = spawnSync(
          "fish",
          ["--private", "-c", 'printf "%s" "$OPENCLAW_TEST_COMPLETION_READY"'],
          { encoding: "utf8", env: process.env },
        );
        expect(actualShell.status).toBe(0);
        expect(actualShell.stdout).toBe("relative-fish");
      },
    );
  });

  it.each([
    { shell: "fish" as const, configuredRoot: "~/literal startup" },
    { shell: "fish" as const, configuredRoot: "~root/literal startup" },
    { shell: "fish" as const, configuredRoot: "-literal startup" },
    { shell: "fish" as const, configuredRoot: "+literal startup" },
    { shell: "zsh" as const, configuredRoot: "~/literal startup" },
    { shell: "zsh" as const, configuredRoot: "~root/literal startup" },
    { shell: "zsh" as const, configuredRoot: "-literal startup" },
    { shell: "zsh" as const, configuredRoot: "+literal startup" },
  ])("executes a $shell reload for literal relative root $configuredRoot", async (testCase) => {
    const shellVersion = spawnSync(testCase.shell, ["--version"], { encoding: "utf8" });
    if (shellVersion.error) {
      return;
    }

    const tempDir = tempDirs.make(`openclaw-${testCase.shell}-literal-startup-`);
    const homeDir = path.join(tempDir, "home");
    const profileSegments = testCase.shell === "fish" ? ["fish", "config.fish"] : [".zshrc"];
    const profilePath = path.join(tempDir, testCase.configuredRoot, ...profileSegments);
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(
      profilePath,
      testCase.shell === "fish"
        ? "set -gx OPENCLAW_TEST_COMPLETION_READY literal-shell\n"
        : "export OPENCLAW_TEST_COMPLETION_READY=literal-shell\n",
    );

    if (testCase.shell === "zsh") {
      await fs.writeFile(
        path.join(homeDir, ".zshenv"),
        `builtin cd -- ${JSON.stringify(tempDir)}\nZDOTDIR=${JSON.stringify(testCase.configuredRoot)}\n`,
      );
    }

    const env = {
      ...process.env,
      HOME: homeDir,
      ZDOTDIR: undefined,
      XDG_CONFIG_HOME: testCase.shell === "fish" ? testCase.configuredRoot : undefined,
    };
    const profileHint = resolveCompletionProfileHint(testCase.shell, {
      env,
      homeDir: () => homeDir,
    });
    const expectedHint =
      testCase.shell === "fish"
        ? `./${testCase.configuredRoot}/${profileSegments.join("/")}`
        : `${tempDir}/${testCase.configuredRoot}/${profileSegments.join("/")}`;
    expect(profileHint).toBe(expectedHint);

    const reloadCommand = formatCompletionReloadCommand(testCase.shell, profileHint);
    const shellArguments = testCase.shell === "fish" ? ["--private", "--no-config"] : ["-f", "-i"];
    const actualShell = spawnSync(
      testCase.shell,
      [...shellArguments, "-c", `${reloadCommand}; printf "%s" "$OPENCLAW_TEST_COMPLETION_READY"`],
      { encoding: "utf8", env, cwd: tempDir },
    );
    expect(actualShell.status).toBe(0);
    expect(actualShell.stderr).toBe("");
    expect(actualShell.stdout).toBe("literal-shell");
  });

  it("anchors a relative ZDOTDIR to the actual .zshenv working directory", async () => {
    const zshVersion = spawnSync("zsh", ["--version"], { encoding: "utf8" });
    if (zshVersion.error) {
      return;
    }

    const tempDir = tempDirs.make("openclaw-zsh-startup-working-directory-");
    const homeDir = path.join(tempDir, "home");
    const workingDirectory = path.join(tempDir, "actual working directory");
    const configuredRoot = "relative startup";
    const profilePath = path.join(workingDirectory, configuredRoot, ".zshrc");
    const stateDir = path.join(tempDir, "state");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(workingDirectory, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".zshenv"),
      `builtin cd -- ${JSON.stringify(workingDirectory)}\nZDOTDIR=${JSON.stringify(configuredRoot)}\n`,
    );

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        SHELL: "/bin/zsh",
        ZDOTDIR: undefined,
        OPENCLAW_TEST_COMPLETION_READY: undefined,
      },
      async () => {
        const cachePath = resolveCompletionCachePath("zsh", "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "export OPENCLAW_TEST_COMPLETION_READY=relative-zsh\n");

        expect(resolveCompletionProfilePath("zsh")).toBe(profilePath);
        expect(resolveCompletionProfileHint("zsh")).toBe(profilePath);
        await installCompletion("zsh", true, "openclaw");
        await expect(fs.readFile(profilePath, "utf8")).resolves.toContain(cachePath);

        const actualShell = spawnSync(
          "zsh",
          ["-i", "-c", 'printf "%s" "$OPENCLAW_TEST_COMPLETION_READY"'],
          { encoding: "utf8", env: process.env },
        );
        expect(actualShell.status).toBe(0);
        expect(actualShell.stdout).toBe("relative-zsh");
      },
    );
  });

  it("discovers a shell-local ZDOTDIR declared without export in .zshenv", async () => {
    const zshVersion = spawnSync("zsh", ["--version"], { encoding: "utf8" });
    if (zshVersion.error) {
      return;
    }

    const tempDir = tempDirs.make("openclaw-zsh-local-dotdir-");
    const homeDir = path.join(tempDir, "home");
    const stateDir = path.join(tempDir, "state");
    const configuredRoot = path.join(tempDir, "unexported startup");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".zshenv"),
      `ZDOTDIR=${JSON.stringify(configuredRoot)}\n`,
      "utf8",
    );

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        ZDOTDIR: undefined,
        OPENCLAW_TEST_COMPLETION_READY: undefined,
      },
      async () => {
        const profilePath = path.join(configuredRoot, ".zshrc");
        const cachePath = resolveCompletionCachePath("zsh", "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "export OPENCLAW_TEST_COMPLETION_READY=local-zsh\n", "utf8");

        expect(resolveCompletionProfilePath("zsh")).toBe(profilePath);
        await installCompletion("zsh", true, "openclaw");
        await expect(fs.readFile(profilePath, "utf8")).resolves.toContain(cachePath);

        const actualShell = spawnSync(
          "zsh",
          ["-i", "-c", 'printf "%s" "$OPENCLAW_TEST_COMPLETION_READY"'],
          { encoding: "utf8", env: process.env },
        );
        expect(actualShell.status).toBe(0);
        expect(actualShell.stdout).toBe("local-zsh");
      },
    );
  });

  it.each([
    { mode: "interactive-only", inherited: false },
    { mode: "reassigned-inherited", inherited: true },
    { mode: "shadowed-printf", inherited: false },
  ] as const)("discovers the actual $mode Zsh startup profile", async (testCase) => {
    const zshVersion = spawnSync("zsh", ["--version"], { encoding: "utf8" });
    if (zshVersion.error) {
      return;
    }

    const tempDir = tempDirs.make(`openclaw-zsh-${testCase.mode}-`);
    const homeDir = path.join(tempDir, "home");
    const stateDir = path.join(tempDir, "state");
    const inheritedRoot = path.join(tempDir, "initial startup");
    const configuredRoot = path.join(tempDir, "actual startup");
    const startupRoot = testCase.inherited ? inheritedRoot : homeDir;
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(startupRoot, { recursive: true });
    const assignment = `ZDOTDIR=${JSON.stringify(configuredRoot)}`;
    const startupConfig =
      testCase.mode === "interactive-only"
        ? `if [[ -o interactive ]]; then\n  ${assignment}\nfi\n`
        : testCase.mode === "shadowed-printf"
          ? `${assignment}\nprintf() { return 0; }\n`
          : `${assignment}\n`;
    await fs.writeFile(path.join(startupRoot, ".zshenv"), startupConfig, "utf8");

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        SHELL: "/bin/zsh",
        ZDOTDIR: testCase.inherited ? inheritedRoot : undefined,
        OPENCLAW_TEST_COMPLETION_READY: undefined,
      },
      async () => {
        const profilePath = path.join(configuredRoot, ".zshrc");
        const cachePath = resolveCompletionCachePath("zsh", "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "export OPENCLAW_TEST_COMPLETION_READY=actual-zsh\n", "utf8");

        expect(resolveCompletionProfilePath("zsh")).toBe(profilePath);
        await installCompletion("zsh", true, "openclaw");

        const actualShell = spawnSync(
          "zsh",
          ["-i", "-c", 'builtin printf "%s" "$OPENCLAW_TEST_COMPLETION_READY"'],
          { encoding: "utf8", env: process.env },
        );
        expect(actualShell.status).toBe(0);
        expect(actualShell.stdout).toBe("actual-zsh");
      },
    );
  });

  it("captures the Zsh profile before loading user .zshrc side effects", async () => {
    const zshVersion = spawnSync("zsh", ["--version"], { encoding: "utf8" });
    if (zshVersion.error) {
      return;
    }

    const tempDir = tempDirs.make("openclaw-zsh-no-zshrc-side-effects-");
    const homeDir = path.join(tempDir, "home");
    const configuredRoot = path.join(tempDir, "actual startup");
    const misleadingRoot = path.join(tempDir, "changed after startup");
    const sideEffectPath = path.join(tempDir, "zshrc-was-loaded");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(configuredRoot, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".zshenv"),
      `ZDOTDIR=${JSON.stringify(configuredRoot)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(configuredRoot, ".zshrc"),
      `ZDOTDIR=${JSON.stringify(misleadingRoot)}\nprintf ran > ${JSON.stringify(sideEffectPath)}\n`,
      "utf8",
    );

    expect(
      resolveCompletionProfilePath("zsh", {
        env: { ...process.env, HOME: homeDir, SHELL: "/bin/zsh", ZDOTDIR: undefined },
        homeDir: () => homeDir,
      }),
    ).toBe(path.join(configuredRoot, ".zshrc"));
    await expect(fs.access(sideEffectPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forcibly bounds Zsh startup discovery when .zshenv ignores SIGTERM", async () => {
    const zshVersion = spawnSync("zsh", ["--version"], { encoding: "utf8" });
    if (zshVersion.error || process.platform === "win32") {
      return;
    }

    const homeDir = tempDirs.make("openclaw-zsh-bounded-startup-");
    await fs.writeFile(
      path.join(homeDir, ".zshenv"),
      'trap "" TERM\ninteger deadline=$((SECONDS + 4))\nwhile (( SECONDS < deadline )); do :; done\n',
      "utf8",
    );

    const startedAt = Date.now();
    expect(
      resolveCompletionProfilePath("zsh", {
        env: { ...process.env, HOME: homeDir, ZDOTDIR: undefined },
        homeDir: () => homeDir,
      }),
    ).toBe(path.join(homeDir, ".zshrc"));
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("bounds Zsh discovery when a startup descendant keeps stdout open", async () => {
    const zshVersion = spawnSync("zsh", ["--version"], { encoding: "utf8" });
    if (zshVersion.error || process.platform === "win32") {
      return;
    }

    const homeDir = tempDirs.make("openclaw-zsh-bounded-descendant-");
    await fs.writeFile(path.join(homeDir, ".zshenv"), "(sleep 4) &\n", "utf8");

    const startedAt = Date.now();
    expect(
      resolveCompletionProfilePath("zsh", {
        env: { ...process.env, HOME: homeDir, ZDOTDIR: undefined },
        homeDir: () => homeDir,
      }),
    ).toBe(path.join(homeDir, ".zshrc"));
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it.each([
    {
      shell: "zsh" as const,
      profilePath: "~/configured startup/.zshrc",
      expected: 'source "$HOME/configured startup/.zshrc"',
    },
    {
      shell: "fish" as const,
      profilePath: "~/configured startup/fish/config.fish",
      expected: 'source "$HOME/configured startup/fish/config.fish"',
    },
    {
      shell: "bash" as const,
      profilePath: "/tmp/configured startup/.bashrc",
      expected: 'source "/tmp/configured startup/.bashrc"',
    },
    {
      shell: "zsh" as const,
      profilePath: '/tmp/shell $state/"quoted"/.zshrc',
      expected: 'source "/tmp/shell \\$state/\\"quoted\\"/.zshrc"',
    },
    {
      shell: "zsh" as const,
      profilePath: "~/owner's ! startup/.zshrc",
      expected: `source "$HOME"/'owner'\\''s ! startup/.zshrc'`,
    },
    {
      shell: "bash" as const,
      profilePath: "/tmp/owner's ! startup/.bashrc",
      expected: `source '/tmp/owner'\\''s ! startup/.bashrc'`,
    },
  ])("quotes an executable $shell reload hint for configured profile paths", (testCase) => {
    expect(formatCompletionReloadCommand(testCase.shell, testCase.profilePath)).toBe(
      testCase.expected,
    );
  });

  it.each(configuredShellCases)(
    "executes the quoted $shell reload command for startup paths with shell metacharacters",
    async ({ shell, envName, profileSegments, cacheContent }) => {
      const shellVersion = spawnSync(shell, ["--version"], { encoding: "utf8" });
      if (shellVersion.error) {
        return;
      }

      const tempDir = tempDirs.make(`openclaw-${shell}-reload-spaces-`);
      const homeDir = path.join(tempDir, "home");
      const stateDir = path.join(tempDir, `state $cache "quoted"! owner's`);
      const configuredRoot = path.join(homeDir, `configured $startup "profiles"! owner's`);
      const profilePath = path.join(configuredRoot, ...profileSegments);
      await fs.mkdir(homeDir, { recursive: true });

      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
          ZDOTDIR: envName === "ZDOTDIR" ? configuredRoot : undefined,
          XDG_CONFIG_HOME: envName === "XDG_CONFIG_HOME" ? configuredRoot : undefined,
          OPENCLAW_TEST_COMPLETION_READY: undefined,
        },
        async () => {
          const cachePath = resolveCompletionCachePath(shell, "openclaw");
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, cacheContent, "utf8");
          await installCompletion(shell, true, "openclaw");

          const profileHint = path.join("~", path.relative(homeDir, profilePath));
          const command = formatCompletionReloadCommand(shell, profileHint);
          const actualShell = spawnSync(
            shell,
            ["-c", `${command}; printf '%s' "$OPENCLAW_TEST_COMPLETION_READY"`],
            { encoding: "utf8", env: process.env },
          );

          expect(actualShell.status).toBe(0);
          expect(actualShell.stderr).toBe("");
          expect(actualShell.stdout).toBe(shell);
        },
      );
    },
  );

  it("resolves the documented Bash login profile when .bashrc is absent", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      expect(resolveCompletionProfilePath("bash")).toBe(path.join(homeDir, ".bash_profile"));
    });
  });

  it("recognizes cached Bash completion installed into the login profile", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");

      await installCompletion("bash", true, "openclaw");

      const profilePath = path.join(homeDir, ".bash_profile");
      await expect(fs.readFile(profilePath, "utf-8")).resolves.toContain(cachePath);
      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
      await expect(usesSlowDynamicCompletion("bash", "openclaw")).resolves.toBe(false);

      const shell = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          'source "$1"; complete -p openclaw',
          "openclaw",
          profilePath,
        ],
        { encoding: "utf8" },
      );
      expect(shell.stderr).toBe("");
      expect(shell.status).toBe(0);
      expect(shell.stdout).toContain("complete -W 'status' openclaw");
    });
  });

  it("detects slow dynamic Bash completion in the login profile", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      await fs.writeFile(
        path.join(homeDir, ".bash_profile"),
        "source <(openclaw completion --shell bash)\n",
        "utf-8",
      );

      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
      await expect(usesSlowDynamicCompletion("bash", "openclaw")).resolves.toBe(true);
    });
  });

  it("does not mistake an orphaned completion marker for an installed profile", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(
        path.join(homeDir, ".bash_profile"),
        "# OpenClaw Completion\nexport IMPORTANT=keep\n",
        "utf-8",
      );

      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(false);
    });
  });

  it("recognizes an installed profile when its completion cache has been removed", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      await fs.writeFile(
        path.join(homeDir, ".bash_profile"),
        `# OpenClaw Completion\n[ -f "${cachePath}" ] && source "${cachePath}"\n`,
        "utf-8",
      );

      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
    });
  });

  it.each(COMPLETION_SHELLS)(
    "replaces the old generated %s source after the state directory changes",
    async (shell) => {
      await withBashCompletionHome(async ({ stateDir }) => {
        const previousStateDir = tempDirs.make("openclaw-completion-previous-state-");
        let previousCachePath = "";
        await withEnvAsync({ OPENCLAW_STATE_DIR: previousStateDir }, async () => {
          previousCachePath = resolveCompletionCachePath(shell, "openclaw");
          await fs.mkdir(path.dirname(previousCachePath), { recursive: true });
          await fs.writeFile(previousCachePath, "# previous completion\n", "utf-8");
          await installCompletion(shell, true, "openclaw");
        });

        const currentCachePath = resolveCompletionCachePath(shell, "openclaw");
        expect(currentCachePath).toContain(stateDir);
        await fs.mkdir(path.dirname(currentCachePath), { recursive: true });
        await fs.writeFile(currentCachePath, "# current completion\n", "utf-8");
        await installCompletion(shell, true, "openclaw");

        const profile = await fs.readFile(resolveCompletionProfilePath(shell), "utf-8");
        expect(profile).toContain(currentCachePath);
        expect(profile).not.toContain(previousCachePath);
        expect(profile.match(/^# OpenClaw Completion$/gm)).toHaveLength(1);
      });
    },
  );

  it("preserves unrelated generated-looking sources that are not owned by its profile marker", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      const unrelatedSource = 'source "/opt/tools/completions/openclaw.zsh"';
      const unmarkedPriorSource = 'source "/opt/tools/completions/openclaw.bash"';
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# current completion\n", "utf-8");
      await fs.writeFile(profilePath, `${unrelatedSource}\n${unmarkedPriorSource}\n`, "utf-8");

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain(`${unrelatedSource}\n`);
      expect(profile).toContain(`${unmarkedPriorSource}\n`);
      expect(profile).toContain(cachePath);
    });
  });

  it("prefers an existing .bashrc over the Bash login profile", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const bashrc = path.join(homeDir, ".bashrc");
      const bashProfile = path.join(homeDir, ".bash_profile");
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      await fs.writeFile(bashrc, "# existing interactive Bash profile\n", "utf-8");
      await fs.writeFile(bashProfile, "# existing Bash login profile\n", "utf-8");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");

      expect(resolveCompletionProfilePath("bash")).toBe(bashrc);
      await installCompletion("bash", true, "openclaw");

      await expect(fs.readFile(bashrc, "utf-8")).resolves.toContain(cachePath);
      await expect(fs.readFile(bashProfile, "utf-8")).resolves.toBe(
        "# existing Bash login profile\n",
      );
      await expect(isCompletionInstalled("bash", "openclaw")).resolves.toBe(true);
      await expect(usesSlowDynamicCompletion("bash", "openclaw")).resolves.toBe(false);
    });
  });

  it("preserves unrelated profile lines while replacing orphaned completion blocks", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      const refreshAlias = "alias refresh_openclaw='openclaw completion --write-state'";
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(
        profilePath,
        `# OpenClaw Completion\nexport IMPORTANT=keep\n${refreshAlias}\n`,
        "utf-8",
      );

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain("export IMPORTANT=keep\n");
      expect(profile).toContain(`${refreshAlias}\n`);
      expect(profile.match(/^# OpenClaw Completion$/gm)).toHaveLength(1);
      expect(profile).toContain(cachePath);
    });
  });

  it("replaces documented dynamic completion without deleting unrelated aliases", async () => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      const refreshAlias = "alias refresh_openclaw='openclaw completion --write-state'";
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(
        profilePath,
        `export IMPORTANT=keep\nsource <(openclaw completion --shell bash)\n${refreshAlias}\n`,
        "utf-8",
      );

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain("export IMPORTANT=keep\n");
      expect(profile).toContain(`${refreshAlias}\n`);
      expect(profile).not.toContain("source <(openclaw completion");
      expect(profile).toContain(cachePath);
    });
  });

  it.each([
    "export IMPORTANT=keep; source <(openclaw completion --shell bash)",
    "source <(openclaw completion --shell bash); export IMPORTANT=keep",
    'source <(openclaw completion --shell bash) >"$HOME/completion.log"',
    'eval "$(openclaw completion --shell bash)" >"$HOME/completion.log"',
    'source <(openclaw completion --shell bash >"$HOME/completion.log")',
  ])("preserves compound user-owned Bash profile statements: %s", async (compoundLine) => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(profilePath, `${compoundLine}\n`, "utf-8");

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain(`${compoundLine}\n`);
      expect(profile).toContain(`[ -f "${cachePath}" ] && source "${cachePath}"`);
    });
  });

  it.each([
    {
      name: "dot-sourced process substitution",
      sourceLine: ". <(openclaw completion --shell bash)",
    },
    {
      name: "eval command substitution",
      sourceLine: 'eval "$(openclaw completion --shell bash)"',
    },
  ])("replaces $name without deleting unrelated aliases", async ({ sourceLine }) => {
    await withBashCompletionHome(async ({ homeDir }) => {
      const cachePath = resolveCompletionCachePath("bash", "openclaw");
      const profilePath = path.join(homeDir, ".bash_profile");
      const refreshAlias = "alias refresh_openclaw='openclaw completion --write-state'";
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "complete -W 'status' openclaw\n", "utf-8");
      await fs.writeFile(profilePath, `${sourceLine}\n${refreshAlias}\n`, "utf-8");

      await installCompletion("bash", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).not.toContain(sourceLine);
      expect(profile).toContain(`${refreshAlias}\n`);
      expect(profile).toContain(cachePath);
    });
  });

  it("replaces PowerShell dynamic pipelines without deleting unrelated command strings", async () => {
    await withBashCompletionHome(async () => {
      const cachePath = resolveCompletionCachePath("powershell", "openclaw");
      const profilePath = resolveCompletionProfilePath("powershell");
      const dynamicLine = "openclaw completion --shell powershell | Out-String | Invoke-Expression";
      const refreshCommand = '$refresh = "openclaw completion --write-state"';
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# PowerShell completion\n", "utf-8");
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, `${dynamicLine}\n${refreshCommand}\n`, "utf-8");

      await expect(usesSlowDynamicCompletion("powershell", "openclaw")).resolves.toBe(true);
      await installCompletion("powershell", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).not.toContain(dynamicLine);
      expect(profile).toContain(`${refreshCommand}\n`);
      expect(profile).toContain(cachePath);
    });
  });

  it.each([
    "openclaw completion --shell powershell | Out-String | Invoke-Expression; $env:IMPORTANT = 'keep'",
    'openclaw completion --shell powershell | Tee-Object "$HOME/generated.ps1" | Out-String | Invoke-Expression',
  ])("preserves compound user-owned PowerShell profile statements: %s", async (compoundLine) => {
    await withBashCompletionHome(async () => {
      const cachePath = resolveCompletionCachePath("powershell", "openclaw");
      const profilePath = resolveCompletionProfilePath("powershell");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# PowerShell completion\n", "utf-8");
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, `${compoundLine}\n`, "utf-8");

      await installCompletion("powershell", true, "openclaw");

      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toContain(`${compoundLine}\n`);
      expect(profile).toContain(`. '${cachePath}'`);
    });
  });

  it("formats PowerShell reload commands with single-quoted paths", () => {
    expect(formatCompletionReloadCommand("powershell", "C:\\Users\\Ada\\profile.ps1")).toBe(
      ". 'C:\\Users\\Ada\\profile.ps1'",
    );
  });

  it("detects PowerShell shell names from Windows paths", () => {
    expect(resolveShellFromEnv({ SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" })).toBe(
      "powershell",
    );
    expect(
      resolveShellFromEnv({
        SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }),
    ).toBe("powershell");
  });

  it("resolves Windows PowerShell and pwsh profile directories", () => {
    expect(
      resolveCompletionProfilePath("powershell", {
        env: {
          SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
          USERPROFILE: "C:\\Users\\Ada",
        },
        homeDir: () => "C:\\Users\\Ada",
        platform: "win32",
      }),
    ).toBe(
      path.win32.join(
        "C:\\Users\\Ada",
        "Documents",
        "PowerShell",
        "Microsoft.PowerShell_profile.ps1",
      ),
    );
    expect(
      resolveCompletionProfilePath("powershell", {
        env: {
          SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          USERPROFILE: "C:\\Users\\Ada",
        },
        homeDir: () => "C:\\Users\\Ada",
        platform: "win32",
      }),
    ).toBe(
      path.win32.join(
        "C:\\Users\\Ada",
        "Documents",
        "WindowsPowerShell",
        "Microsoft.PowerShell_profile.ps1",
      ),
    );
  });

  it("keeps Windows Bash profile paths native and reload hints shell-executable", () => {
    const homeDir = "C:\\Users\\Ada";
    const options = {
      env: { HOME: homeDir },
      homeDir: () => homeDir,
      platform: "win32" as const,
    };

    expect(resolveCompletionProfilePath("bash", options)).toBe(
      path.win32.join(homeDir, ".bash_profile"),
    );
    expect(resolveCompletionProfileHint("bash", options)).toBe("~/.bash_profile");
    expect(
      formatCompletionReloadCommand("bash", resolveCompletionProfileHint("bash", options)),
    ).toBe("source ~/.bash_profile");
  });

  it.each([
    {
      shell: "zsh" as const,
      env: { HOME: "C:\\Users\\Ada", ZDOTDIR: "D:\\configured shell" },
      profile: "D:\\configured shell\\.zshrc",
      hint: "D:/configured shell/.zshrc",
    },
    {
      shell: "fish" as const,
      env: { HOME: "C:\\Users\\Ada", XDG_CONFIG_HOME: "D:\\configured shell" },
      profile: "D:\\configured shell\\fish\\config.fish",
      hint: "D:/configured shell/fish/config.fish",
    },
  ])("formats external Windows $shell profiles for the target shell", (testCase) => {
    const options = {
      env: testCase.env,
      homeDir: () => "C:\\Users\\Ada",
      platform: "win32" as const,
    };

    expect(resolveCompletionProfilePath(testCase.shell, options)).toBe(testCase.profile);
    expect(resolveCompletionProfileHint(testCase.shell, options)).toBe(testCase.hint);
    expect(
      formatCompletionReloadCommand(
        testCase.shell,
        resolveCompletionProfileHint(testCase.shell, options),
      ),
    ).toBe(`source "${testCase.hint}"`);
  });

  it("installs PowerShell completion into the concrete profile path", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-bob's-"));

    try {
      await withEnvAsync({ HOME: homeDir, OPENCLAW_STATE_DIR: stateDir }, async () => {
        const cachePath = resolveCompletionCachePath("powershell", "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "# powershell completion\n", "utf-8");

        await installCompletion("powershell", true, "openclaw");

        const profilePath = resolveCompletionProfilePath("powershell");
        const profile = await fs.readFile(profilePath, "utf-8");
        expect(profile).toBe(`# OpenClaw Completion\n. '${cachePath.replace(/'/g, "''")}'\n`);
      });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects install when the completion cache is missing", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));

    try {
      await withEnvAsync({ HOME: homeDir, OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(installCompletion("zsh", true, "openclaw")).rejects.toThrow(
          "Completion cache not found",
        );
      });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
