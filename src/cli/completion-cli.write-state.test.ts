import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
import { formatCliFailureLines, isExpectedCliError } from "./failure-output.js";

type PublishOutput = typeof import("./output-file.runtime.js").publishOutputFileAtomically;
type SubcliGroups = typeof import("./program/register.subclis.js").getSubCliCompletionGroups;

const publish = vi.hoisted(() => vi.fn<PublishOutput>());
const stderrWrites = vi.hoisted(() => vi.fn());
const coreGroups = vi.hoisted(() => vi.fn(() => []));
const programContext = vi.hoisted(() => vi.fn(() => null));
const { subcliGroups, qaGroup } = vi.hoisted(() => {
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
    qaGroup: group,
    subcliGroups: vi.fn<SubcliGroups>(() => [group]),
  };
});
const registerPlugins = vi.hoisted(() => vi.fn(async (_program: Command) => ({})));

vi.mock("./output-file.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
    "./output-file.runtime.js",
  );
  publish.mockImplementation(actual.publishOutputFileAtomically);
  return { ...actual, publishOutputFileAtomically: publish };
});

// mock-isolation: Generate completions from the bounded fixture command registry.
vi.mock("./program/command-registry-core.js", () => ({
  getCoreCliCompletionGroups: coreGroups,
}));

// mock-isolation: Supply fixture program context without bootstrapping a real CLI session.
vi.mock("./program/program-context.js", () => ({
  getProgramContext: programContext,
}));

// mock-isolation: Keep completion fixtures independent of the installed subcommand registry.
vi.mock("./program/register.subclis.js", () => ({
  getSubCliCompletionGroups: subcliGroups,
}));

// mock-isolation: Register only fixture plugins without reading operator plugin state.
vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: registerPlugins,
}));

async function runCompletion(args: string[]): Promise<Command> {
  const { registerCompletionCli } = await import("./completion-cli.js");
  const program = new Command().name("openclaw");
  registerCompletionCli(program);
  await program.parseAsync(["completion", ...args], { from: "user" });
  return program;
}

async function writeCache(shell: CompletionShell): Promise<string> {
  const { getCompletionScript } = await import("./completion-cli.js");
  const program = await runCompletion(["--shell", shell, "--write-state"]);
  return getCompletionScript(shell, program);
}

async function seedCache(shell: CompletionShell = "zsh", contents = "# previous completion\n") {
  const cachePath = resolveCompletionCachePath(shell, "openclaw");
  const cacheDir = path.dirname(cachePath);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, contents, "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(cacheDir, 0o750);
    await fs.chmod(cachePath, 0o640);
  }
  return { cachePath, cacheDir };
}

async function expectCacheModes(cachePath: string, cacheDir: string) {
  expect(await fs.readdir(cacheDir)).toEqual([path.basename(cachePath)]);
  if (process.platform !== "win32") {
    expect((await fs.stat(cachePath)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(cacheDir)).mode & 0o777).toBe(0o750);
  }
}

function expectNoRegistration(): void {
  expect(programContext).not.toHaveBeenCalled();
  expect(coreGroups).not.toHaveBeenCalled();
  expect(subcliGroups).not.toHaveBeenCalled();
  expect(registerPlugins).not.toHaveBeenCalled();
  expect(stderrWrites).not.toHaveBeenCalled();
}

function expectRegistrationWarning() {
  expect(subcliGroups).toHaveBeenCalledTimes(1);
  expect(registerPlugins).toHaveBeenCalledTimes(1);
  expect(stderrWrites.mock.calls).toEqual([
    [
      "[completion] skipping subcommand `qa` while building completion cache: qa scenario pack not found: qa/scenarios/index.yaml\n",
    ],
  ]);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("completion-cli write-state", () => {
  let publishAtomically: PublishOutput;

  beforeEach(async () => {
    const stateDir = tempDirs.make("openclaw-completion-state-");
    const homeDir = tempDirs.make("openclaw-completion-home-");
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
    publishAtomically = actual.publishOutputFileAtomically;
    publish.mockReset().mockImplementation(publishAtomically);
    stderrWrites.mockReset();
    coreGroups.mockClear();
    programContext.mockClear();
    subcliGroups.mockClear();
    registerPlugins.mockReset().mockResolvedValue({});
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrWrites(chunk.toString());
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["bash", "zsh"] as const)(
    "prints the missing-cache recovery command and leaves the %s profile unchanged",
    async (shell) => {
      const profilePath = resolveCompletionProfilePath(shell);
      const original = "# existing shell settings\n";
      await fs.writeFile(profilePath, original, "utf8");

      let caught: unknown;
      try {
        await runCompletion(["--shell", shell, "--install", "--yes"]);
      } catch (error) {
        caught = error;
      }

      expect(isExpectedCliError(caught)).toBe(true);
      const lines = formatCliFailureLines({
        title: "The CLI command failed.",
        error: caught,
        argv: ["node", "openclaw", "completion", "--shell", shell, "--install", "--yes"],
      });
      expect(lines.join("\n")).toContain("openclaw completion --write-state");
      expect(lines.join("\n")).not.toContain("doctor");
      await expect(fs.readFile(profilePath, "utf8")).resolves.toBe(original);
      expectNoRegistration();
    },
  );

  it("preserves zsh completion when staged publication fails", async () => {
    const { cachePath, cacheDir } = await seedCache();
    publish.mockImplementationOnce(async (params) => {
      return await publishAtomically({
        ...params,
        writeTemp: async (tempPath) => {
          await params.writeTemp(tempPath);
          await fs.truncate(tempPath, 1);
          throw new Error("injected completion cache write failure");
        },
      });
    });

    await expect(writeCache("zsh")).rejects.toThrow("injected completion cache write failure");

    await expect(fs.readFile(cachePath, "utf8")).resolves.toBe("# previous completion\n");
    await expectCacheModes(cachePath, cacheDir);
  });

  it.skipIf(process.platform === "win32").each(["cache", "temporary"] as const)(
    "protects symlink targets at the %s publication path",
    async (location) => {
      const { cachePath, cacheDir } = await seedCache();
      const protectedPath = path.join(path.dirname(cacheDir), "protected-script");
      await fs.writeFile(protectedPath, "# protected script\n", "utf8");
      let expectedScript = "# previous completion\n";
      if (location === "cache") {
        await fs.unlink(cachePath);
        await fs.symlink(protectedPath, cachePath);
        expectedScript = await writeCache("zsh");
        expect((await fs.lstat(cachePath)).isSymbolicLink()).toBe(false);
      } else {
        publish.mockImplementationOnce((params) =>
          publishAtomically({
            ...params,
            writeTemp: async (tempPath) => {
              await fs.symlink(protectedPath, tempPath);
              return params.writeTemp(tempPath);
            },
          }),
        );
        await expect(writeCache("zsh")).rejects.toThrow(/EEXIST/u);
      }
      await expect(fs.readFile(cachePath, "utf8")).resolves.toBe(expectedScript);
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

      await expect(writeCache("zsh")).rejects.toThrow("directory component must be a directory");

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
      expectNoRegistration();
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
    expectNoRegistration();
  });

  it("generates and installs completion after registering commands and plugins", async () => {
    const { cachePath, cacheDir } = await seedCache();
    const profilePath = resolveCompletionProfilePath("zsh");
    await fs.writeFile(profilePath, "", { mode: 0o640 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const program = await runCompletion(["--shell", "zsh", "--write-state", "--install", "--yes"]);

    const { getCompletionScript } = await import("./completion-cli.js");
    await expect(fs.readFile(cachePath, "utf8")).resolves.toBe(getCompletionScript("zsh", program));
    await expectCacheModes(cachePath, cacheDir);
    await expect(fs.readFile(profilePath, "utf8")).resolves.toContain(cachePath);
    if (process.platform !== "win32") {
      expect((await fs.stat(profilePath)).mode & 0o777).toBe(0o640);
    }
    expect(log).toHaveBeenCalledWith(
      "Completion installed. Restart your shell or run: source ~/.zshrc",
    );
    expectRegistrationWarning();
  });

  it("keeps completion cache generation alive when a subcli fails to register", async () => {
    subcliGroups.mockReturnValueOnce([
      qaGroup,
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
    registerPlugins.mockImplementationOnce(async (program) => {
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
    expectRegistrationWarning();
  });

  it("writes core completion with a warning when invalid config prevents plugin discovery", async () => {
    registerPlugins.mockRejectedValueOnce(
      createInvalidConfigError("/tmp/openclaw.json", "- gateway.port: Expected a number"),
    );

    await writeCache("zsh");

    await expect(
      fs.readFile(resolveCompletionCachePath("zsh", "openclaw"), "utf8"),
    ).resolves.toContain("#compdef openclaw");
    expect(stderrWrites).toHaveBeenCalledWith(
      expect.stringContaining("skipping plugin commands: Invalid config"),
    );
  });

  it("does not publish completion after an unrelated plugin registration failure", async () => {
    const error = new Error("plugin registrar failed");
    registerPlugins.mockRejectedValueOnce(error);

    await expect(writeCache("zsh")).rejects.toBe(error);

    expect(publish).not.toHaveBeenCalled();
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
    subcliGroups.mockReturnValueOnce(
      getSubCliCompletionGroups(["node", "openclaw", "completion", "--write-state"]).filter(
        ({ name }) => name === "nodes",
      ),
    );
    registerPlugins.mockImplementation((program) => {
      const nodes = program.commands.find((command) => command.name() === "nodes");
      if (nodes && !nodes.commands.some((command) => command.name() === "plugin-fixture")) {
        nodes.command("plugin-fixture");
      }
      return Promise.resolve({});
    });

    vi.stubEnv(COMPLETION_SKIP_PLUGIN_COMMANDS_ENV, "1");

    await runCompletion(["--write-state"]);

    expect(registerPlugins).not.toHaveBeenCalled();
    for (const shell of COMPLETION_SHELLS) {
      const script = await fs.readFile(resolveCompletionCachePath(shell, "openclaw"), "utf8");
      expect(script).toContain("nodes");
      expect(script).toContain("invoke");
      expect(script).not.toContain("plugin-fixture");
    }
  });
});
