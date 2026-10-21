import { stripVTControlCharacters } from "node:util";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitError } from "../../runtime.js";
import { configureProgramHelp, formatProgramHelpOutput } from "./help.js";
import { OpenClawCommand } from "./openclaw-command.js";
import { captureStdout } from "./program.test-helpers.js";

const formatCliBannerLineMock = vi.hoisted(() => vi.fn(() => "BANNER-LINE"));
const resolveCommitHashMock = vi.hoisted(() => vi.fn<() => string | null>(() => "abc1234"));

// mock-isolation: Make help link formatting deterministic across terminal capabilities.
vi.mock("../../../packages/terminal-core/src/links.js", () => ({
  formatDocsLink: (_path: string, full: string) => `https://${full}`,
}));

// mock-isolation: Suppress banner side effects while checking command help output.
vi.mock("../banner.js", () => ({
  formatCliBannerLine: formatCliBannerLineMock,
  hasEmittedCliBanner: () => false,
}));

vi.mock("../../infra/git-commit.js", () => ({
  resolveCommitHash: resolveCommitHashMock,
}));

const testProgramContext = { programVersion: "9.9.9-test" };

describe("configureProgramHelp", () => {
  let originalArgv: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    resolveCommitHashMock.mockReturnValue("abc1234");
    vi.stubEnv("OPENCLAW_SUPPRESS_HELP_BANNER", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
    vi.unstubAllEnvs();
  });

  async function parseHelp(argv: string[]) {
    process.argv = ["node", "openclaw", ...argv];
    let stdout = "";
    let stderr = "";
    const program = new OpenClawCommand().enablePositionalOptions().exitOverride();
    configureProgramHelp(program, testProgramContext);
    program.configureOutput({
      writeOut: (value) => {
        stdout += stripVTControlCharacters(formatProgramHelpOutput(value));
      },
      writeErr: (value) => {
        stderr += stripVTControlCharacters(value);
      },
    });
    program.command("models").description("models");
    program.command("claws").description("claws");
    program.command("status").description("status");
    const plugins = program.command("plugins").description("Manage plugins");
    plugins
      .command("list")
      .description("List plugins")
      .action(() => {});

    const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CommanderError);
    return { error: error as CommanderError, stderr, stdout };
  }

  it("keeps valid root, group, subcommand, short, and help-command output successful", async () => {
    const rootHelp = await parseHelp(["--help"]);
    const shortHelp = await parseHelp(["-h"]);
    const groupHelp = await parseHelp(["plugins", "--help"]);
    const subcommandHelp = await parseHelp(["plugins", "list", "--help"]);
    const helpCommand = await parseHelp(["help", "plugins"]);

    for (const result of [rootHelp, shortHelp, groupHelp, subcommandHelp, helpCommand]) {
      expect(result).toMatchObject({ error: { exitCode: 0 }, stderr: "" });
    }
    expect(rootHelp.error.code).toBe("commander.helpDisplayed");
    expect(rootHelp.stdout).toContain("Hint: commands suffixed with * have subcommands");
    expect(rootHelp.stdout).toContain("models *");
    expect(rootHelp.stdout).toContain("claws *");
    expect(rootHelp.stdout).toContain("status");
    expect(rootHelp.stdout).not.toContain("status *");
    expect(rootHelp.stdout).toContain("BANNER-LINE");
    expect(rootHelp.stdout).toContain("Examples:");
    expect(rootHelp.stdout).toContain("openclaw setup --baseline");
    expect(rootHelp.stdout).toContain("https://docs.openclaw.ai/cli");
    expect(shortHelp.stdout).toBe(rootHelp.stdout);
    expect(groupHelp.stdout).toContain("Usage: openclaw plugins [options] [command]");
    expect(subcommandHelp.stdout).toContain("Usage: openclaw plugins list [options]");
    expect(helpCommand.stdout).toBe(groupHelp.stdout);
  });

  it("formats parse errors from the exact Commander command path", async () => {
    let stderr = "";
    const program = new OpenClawCommand().enablePositionalOptions().exitOverride();
    configureProgramHelp(program, testProgramContext);
    program.configureOutput({
      writeErr: (value) => {
        stderr += stripVTControlCharacters(value);
      },
    });
    program
      .command("plugins")
      .option("--source <source>")
      .command("list")
      .action(() => {});

    for (const args of [
      ["plugins", "--source", "list", "list", "--wat"],
      ["plugins", "list", "--still-wat"],
      ["plugins", "lis"],
    ]) {
      process.argv = ["node", "openclaw", ...args];
      expect(
        await program.parseAsync(process.argv).catch((error: unknown) => error),
      ).toBeInstanceOf(CommanderError);
    }

    expect(stderr.match(/Try: openclaw plugins list --help/g)).toHaveLength(2);
    expect(stderr).not.toContain("openclaw plugins list list --help");
    expect(stderr).toContain("Did you mean this?\n  openclaw plugins list\n");
  });

  it.each([
    ["debug", "debug"],
    [" trace ", "trace"],
  ])("accepts allowed --log-level %p through Commander", async (input, expected) => {
    process.argv = ["node", "openclaw", "--log-level", input];
    const program = new Command().exitOverride();
    configureProgramHelp(program, testProgramContext);
    program.action(() => {});
    await program.parseAsync(process.argv);
    expect(program.opts().logLevel).toBe(expected);
  });

  it("rejects invalid --log-level through Commander", async () => {
    process.argv = ["node", "openclaw", "--log-level", "loud"];
    const program = new Command().exitOverride();
    configureProgramHelp(program, testProgramContext);
    program.configureOutput({ writeErr: () => {} });
    await expect(program.parseAsync(process.argv)).rejects.toMatchObject({
      code: "commander.invalidArgument",
      exitCode: 1,
      message: expect.stringContaining("Invalid --log-level"),
    });
  });

  it("suppresses banner formatting when parent default help requests it", async () => {
    process.argv = ["node", "openclaw", "channels"];
    process.env.OPENCLAW_SUPPRESS_HELP_BANNER = "1";
    const program = new Command();
    configureProgramHelp(program, testProgramContext);

    const help = await captureStdout(() => program.outputHelp());
    expect(help).not.toContain("BANNER-LINE");
    expect(formatCliBannerLineMock).not.toHaveBeenCalled();
  });

  it.each([
    ["abc1234", "OpenClaw 9.9.9-test (abc1234)"],
    [null, "OpenClaw 9.9.9-test"],
  ])("prints version with commit %s and exits immediately", (commit, expectedVersion) => {
    process.argv = ["node", "openclaw", "--version"];
    resolveCommitHashMock.mockReturnValue(commit);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("unexpected exit");
    });
    expect(() => configureProgramHelp(new Command(), testProgramContext)).toThrow(new ExitError(0));
    expect(log).toHaveBeenCalledWith(expectedVersion);
    expect(exit).not.toHaveBeenCalled();
  });
});
