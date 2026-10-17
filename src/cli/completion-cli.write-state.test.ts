import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import { expectInstalledCompletionProfile } from "./completion-profile.test-support.js";
import {
  COMPLETION_SHELLS,
  formatCompletionReloadCommand,
  resolveCompletionCachePath,
  resolveCompletionProfileHint,
  resolveCompletionProfilePath,
  type CompletionShell,
} from "./completion-runtime.js";

type PublishOutputFileAtomically =
  typeof import("./output-file.runtime.js").publishOutputFileAtomically;
type GetSubCliCompletionGroups =
  typeof import("./program/register.subclis.js").getSubCliCompletionGroups;

const outputFileMocks = vi.hoisted(() => ({
  publishOutputFileAtomically: vi.fn<PublishOutputFileAtomically>(),
}));
const stderrWrites = vi.hoisted(() => vi.fn());
const getCoreCliCompletionGroupsMock = vi.hoisted(() => vi.fn(() => []));
const getProgramContextMock = vi.hoisted(() => vi.fn(() => null));
const { getSubCliCompletionGroupsMock, qaCompletionGroup } = vi.hoisted(() => {
  const group = {
    name: "qa",
    entry: {
      placeholders: [{ name: "qa", description: "QA commands" }],
      register: async () => {
        throw new Error("qa scenario pack not found: qa/scenarios/index.yaml");
      },
    },
  };
  return {
    qaCompletionGroup: group,
    getSubCliCompletionGroupsMock: vi.fn<GetSubCliCompletionGroups>(() => [group]),
  };
});
const registerPluginCliCommandsFromValidatedConfigMock = vi.hoisted(() =>
  vi.fn(async (_program: Command) => ({})),
);

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

vi.mock("./program/command-registry-core.js", () => ({
  getCoreCliCompletionGroups: getCoreCliCompletionGroupsMock,
}));

vi.mock("./program/program-context.js", () => ({
  getProgramContext: getProgramContextMock,
}));

vi.mock("./program/register.subclis.js", () => ({
  getSubCliCompletionGroups: getSubCliCompletionGroupsMock,
}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: registerPluginCliCommandsFromValidatedConfigMock,
}));

async function runCompletion(args: string[]): Promise<Command> {
  const { registerCompletionCli } = await import("./completion-cli.js");
  const program = new Command().name("openclaw");
  registerCompletionCli(program);
  await program.parseAsync(["completion", ...args], { from: "user" });
  return program;
}

async function writeCompletionCacheForShell(shell: CompletionShell): Promise<string> {
  const { getCompletionScript } = await import("./completion-cli.js");
  const program = await runCompletion(["--shell", shell, "--write-state"]);
  return getCompletionScript(shell, program);
}

async function seedCache(shell: CompletionShell = "zsh", contents = "# previous completion\n") {
  const cachePath = resolveCompletionCachePath(shell, "openclaw");
  const cacheDir = path.dirname(cachePath);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, contents, "utf8");
  return { cachePath, cacheDir };
}

async function setCacheModes(cachePath: string, cacheDir: string) {
  if (process.platform !== "win32") {
    await fs.chmod(cacheDir, 0o750);
    await fs.chmod(cachePath, 0o640);
  }
}

async function expectCacheModes(cachePath: string, cacheDir: string) {
  expect(await fs.readdir(cacheDir)).toEqual([path.basename(cachePath)]);
  if (process.platform !== "win32") {
    expect((await fs.stat(cachePath)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(cacheDir)).mode & 0o777).toBe(0o750);
  }
}

function expectCompletionInstallationToSkipRegistration(): void {
  expect(getProgramContextMock).not.toHaveBeenCalled();
  expect(getCoreCliCompletionGroupsMock).not.toHaveBeenCalled();
  expect(getSubCliCompletionGroupsMock).not.toHaveBeenCalled();
  expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  expect(stderrWrites).not.toHaveBeenCalled();
}

describe("completion-cli write-state", () => {
  let restoreStderrWriteSpy: (() => void) | null = null;
  let directories: string[] = [];

  beforeEach(async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    directories = [stateDir, homeDir];
    for (const [name, value] of Object.entries({
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: undefined,
      ZDOTDIR: undefined,
    })) {
      vi.stubEnv(name, value);
    }
    const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
      "./output-file.runtime.js",
    );
    outputFileMocks.publishOutputFileAtomically.mockReset();
    outputFileMocks.publishOutputFileAtomically.mockImplementation(
      actual.publishOutputFileAtomically,
    );
    stderrWrites.mockReset();
    getCoreCliCompletionGroupsMock.mockClear();
    getProgramContextMock.mockClear();
    getSubCliCompletionGroupsMock.mockClear();
    registerPluginCliCommandsFromValidatedConfigMock.mockReset().mockResolvedValue({});
    const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderrWrites(chunk.toString());
      return true;
    }) as typeof process.stderr.write);
    restoreStderrWriteSpy = () => stderrWriteSpy.mockRestore();
  });

  afterEach(async () => {
    restoreStderrWriteSpy?.();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      directories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it.each(["zsh"] as const)(
    "publishes %s completion atomically without changing existing file or directory modes",
    async (shell) => {
      const { cachePath, cacheDir } = await seedCache(shell);
      await setCacheModes(cachePath, cacheDir);

      const expectedScript = await writeCompletionCacheForShell(shell);

      await expect(fs.readFile(cachePath, "utf8")).resolves.toBe(expectedScript);
      expect(outputFileMocks.publishOutputFileAtomically).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: cachePath,
          tempPrefix: ".openclaw-completion-cache",
        }),
      );
      await expectCacheModes(cachePath, cacheDir);
    },
  );

  it.each(["zsh"] as const)(
    "preserves the existing %s completion when staged publication fails",
    async (shell) => {
      const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
        "./output-file.runtime.js",
      );

      const { cachePath, cacheDir } = await seedCache(shell);
      await setCacheModes(cachePath, cacheDir);
      outputFileMocks.publishOutputFileAtomically.mockImplementationOnce(async (params) => {
        return await actual.publishOutputFileAtomically({
          ...params,
          writeTemp: async (tempPath) => {
            await params.writeTemp(tempPath);
            await fs.truncate(tempPath, 1);
            throw new Error("injected completion cache write failure");
          },
        });
      });

      await expect(writeCompletionCacheForShell(shell)).rejects.toThrow(
        "injected completion cache write failure",
      );

      await expect(fs.readFile(cachePath, "utf8")).resolves.toBe("# previous completion\n");
      await expectCacheModes(cachePath, cacheDir);
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces a completion cache symlink without overwriting its target",
    async () => {
      const cachePath = resolveCompletionCachePath("zsh", "openclaw");
      const cacheDir = path.dirname(cachePath);
      const protectedPath = path.join(path.dirname(cacheDir), "protected-script");
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(protectedPath, "# protected script\n", "utf8");
      await fs.symlink(protectedPath, cachePath);

      const expectedScript = await writeCompletionCacheForShell("zsh");

      expect((await fs.lstat(cachePath)).isSymbolicLink()).toBe(false);
      await expect(fs.readFile(cachePath, "utf8")).resolves.toBe(expectedScript);
      await expect(fs.readFile(protectedPath, "utf8")).resolves.toBe("# protected script\n");
      expect(await fs.readdir(cacheDir)).toEqual([path.basename(cachePath)]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a planted temporary symlink without overwriting its target",
    async () => {
      const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
        "./output-file.runtime.js",
      );

      const { cachePath, cacheDir } = await seedCache();
      const protectedPath = path.join(path.dirname(cacheDir), "protected-script");
      await fs.writeFile(protectedPath, "# protected script\n", "utf8");
      outputFileMocks.publishOutputFileAtomically.mockImplementationOnce(async (params) => {
        return await actual.publishOutputFileAtomically({
          ...params,
          writeTemp: async (tempPath) => {
            await fs.symlink(protectedPath, tempPath);
            return await params.writeTemp(tempPath);
          },
        });
      });

      await expect(writeCompletionCacheForShell("zsh")).rejects.toThrow(/EEXIST/u);

      await expect(fs.readFile(cachePath, "utf8")).resolves.toBe("# previous completion\n");
      await expect(fs.readFile(protectedPath, "utf8")).resolves.toBe("# protected script\n");
      expect(await fs.readdir(cacheDir)).toEqual([path.basename(cachePath)]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked completion cache directory without writing into its target",
    async () => {
      const cachePath = resolveCompletionCachePath("zsh", "openclaw");
      const cacheDir = path.dirname(cachePath);
      const protectedDir = path.join(path.dirname(cacheDir), "protected-directory");
      await fs.mkdir(protectedDir, { recursive: true });
      await fs.symlink(protectedDir, cacheDir, "dir");

      await expect(writeCompletionCacheForShell("zsh")).rejects.toThrow(
        "directory component must be a directory",
      );

      expect((await fs.lstat(cacheDir)).isSymbolicLink()).toBe(true);
      expect(await fs.readdir(protectedDir)).toEqual([]);
    },
  );

  it.each(["bash", "powershell"] as const)(
    "installs cached %s completion visibly and idempotently without registering commands or plugins",
    async (shell) => {
      const { cachePath } = await seedCache(shell, "# cached completion\n");
      const profilePath = resolveCompletionProfilePath(shell);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const args = ["completion", "--shell", shell, "--install", "--yes"];
      const program = await runCompletion(args.slice(1));

      const installedProfile = await fs.readFile(profilePath, "utf8");
      expectInstalledCompletionProfile(installedProfile, shell, cachePath);
      expect(log).toHaveBeenCalledWith(
        `Completion installed. Restart your shell or run: ${formatCompletionReloadCommand(shell, resolveCompletionProfileHint(shell))}`,
      );
      await expect(fs.readFile(cachePath, "utf8")).resolves.toBe("# cached completion\n");

      log.mockClear();
      await program.parseAsync(args, { from: "user" });

      expect(log).toHaveBeenCalledWith(`Completion already installed in ${profilePath}`);
      await expect(fs.readFile(profilePath, "utf8")).resolves.toBe(installedProfile);
      expectCompletionInstallationToSkipRegistration();
    },
  );

  it("detects the active shell for cached installation without registering commands", async () => {
    vi.stubEnv("SHELL", "/usr/bin/fish");

    const { cachePath } = await seedCache("fish", "# fish completion\n");
    await runCompletion(["--install", "--yes"]);

    expectInstalledCompletionProfile(
      await fs.readFile(resolveCompletionProfilePath("fish"), "utf8"),
      "fish",
      cachePath,
    );
    expectCompletionInstallationToSkipRegistration();
  });

  it("generates and installs completion after registering commands and plugins", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runCompletion(["--shell", "zsh", "--write-state", "--install", "--yes"]);

    const cachePath = resolveCompletionCachePath("zsh", "openclaw");
    await expect(fs.readFile(cachePath, "utf8")).resolves.toContain("#compdef openclaw");
    await expect(fs.readFile(resolveCompletionProfilePath("zsh"), "utf8")).resolves.toContain(
      cachePath,
    );
    expect(log).toHaveBeenCalledWith(
      "Completion installed. Restart your shell or run: source ~/.zshrc",
    );
    expect(getSubCliCompletionGroupsMock).toHaveBeenCalledTimes(1);
    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledTimes(1);
    expect(stderrWrites.mock.calls).toEqual([
      [
        "[completion] skipping subcommand `qa` while building completion cache: qa scenario pack not found: qa/scenarios/index.yaml\n",
      ],
    ]);
  });

  it("keeps completion cache generation alive when a subcli fails to register", async () => {
    getSubCliCompletionGroupsMock.mockReturnValueOnce([
      qaCompletionGroup,
      {
        name: "after-qa",
        entry: {
          placeholders: [{ name: "after-qa", description: "Commands registered after QA" }],
          register: async (program) => {
            await setImmediate();
            program.command("after-qa").option("--subcli-ready", "Async subcli option");
          },
        },
      },
    ]);
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async (program) => {
      await Promise.resolve();
      program.command("async-plugin").option("--plugin-ready", "Async plugin option");
      return {};
    });
    await runCompletion(["--write-state"]);

    const cacheDir = path.dirname(resolveCompletionCachePath("zsh", "openclaw"));
    expect((await fs.readdir(cacheDir)).toSorted()).toEqual([
      "openclaw.bash",
      "openclaw.fish",
      "openclaw.ps1",
      "openclaw.zsh",
    ]);
    for (const shell of COMPLETION_SHELLS) {
      const script = await fs.readFile(resolveCompletionCachePath(shell, "openclaw"), "utf8");
      expect(script, shell).toContain("subcli-ready");
      expect(script, shell).toContain("plugin-ready");
    }
    expect(getSubCliCompletionGroupsMock).toHaveBeenCalledTimes(1);
    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledTimes(1);
    expect(stderrWrites.mock.calls).toEqual([
      [
        "[completion] skipping subcommand `qa` while building completion cache: qa scenario pack not found: qa/scenarios/index.yaml\n",
      ],
    ]);
  });

  it("writes core completion with a warning when invalid config prevents plugin discovery", async () => {
    registerPluginCliCommandsFromValidatedConfigMock.mockRejectedValueOnce(
      createInvalidConfigError("/tmp/openclaw.json", "- gateway.port: Expected a number"),
    );

    await writeCompletionCacheForShell("zsh");

    await expect(
      fs.readFile(resolveCompletionCachePath("zsh", "openclaw"), "utf8"),
    ).resolves.toContain("#compdef openclaw");
    expect(stderrWrites).toHaveBeenCalledWith(
      expect.stringContaining("skipping plugin commands: Invalid config"),
    );
  });

  it("does not publish completion after an unrelated plugin registration failure", async () => {
    const error = new Error("plugin registrar failed");
    registerPluginCliCommandsFromValidatedConfigMock.mockRejectedValueOnce(error);

    await expect(writeCompletionCacheForShell("zsh")).rejects.toBe(error);

    expect(outputFileMocks.publishOutputFileAtomically).not.toHaveBeenCalled();
  });

  it("structures completion registration warnings for JSON console output", async () => {
    const logging = await import("../logging.js");
    try {
      logging.setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });

      await runCompletion(["--write-state"]);

      expect(stderrWrites).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stderrWrites.mock.calls[0]?.[0]))).toMatchObject({
        level: "warn",
        message: expect.stringContaining("skipping subcommand `qa`"),
      });
    } finally {
      logging.resetLogger();
    }
  });

  it("skips plugin registration during cache writes through the nodes registrar", async () => {
    const { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } = await import("./completion-runtime.js");
    const { getSubCliCompletionGroups } = await vi.importActual<
      typeof import("./program/register.subclis.js")
    >("./program/register.subclis.js");
    getSubCliCompletionGroupsMock.mockReturnValueOnce(
      getSubCliCompletionGroups(["node", "openclaw", "completion", "--write-state"]).filter(
        ({ name }) => name === "nodes",
      ),
    );
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementation((program) => {
      const nodes = program.commands.find((command) => command.name() === "nodes");
      if (nodes && !nodes.commands.some((command) => command.name() === "plugin-fixture")) {
        nodes.command("plugin-fixture");
      }
      return Promise.resolve({});
    });

    vi.stubEnv(COMPLETION_SKIP_PLUGIN_COMMANDS_ENV, "1");

    await runCompletion(["--write-state"]);

    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
    for (const shell of COMPLETION_SHELLS) {
      const script = await fs.readFile(resolveCompletionCachePath(shell, "openclaw"), "utf8");
      expect(script).toContain("nodes");
      expect(script).toContain("invoke");
      expect(script).not.toContain("plugin-fixture");
    }
  });
});
