import { stripVTControlCharacters } from "node:util";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitError } from "../../runtime.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
import { configureProgramHelp, formatProgramHelpOutput } from "./help.js";
import { OpenClawCommand } from "./openclaw-command.js";
import { outputRootHelp } from "./root-help.js";

function descriptor(
  name: string,
  description = name,
  hasSubcommands = false,
): NamedCommandDescriptor {
  return { name, description, hasSubcommands };
}
const pluginDescriptors = vi.fn(async (_config?: unknown, _env?: unknown, _options?: unknown) => [
  descriptor("matrix", "Matrix channel utilities", true),
]);
// mock-isolation: Render descriptor fixtures without loading live plugins.
vi.mock("../../plugins/cli-root-descriptors.js", () => ({
  getPluginCliCommandDescriptors: (...args: [unknown?, unknown?, unknown?]) =>
    pluginDescriptors(...args),
}));

const resolveCommitHashMock = vi.hoisted(() => vi.fn<() => string | null>(() => "abc1234"));

// mock-isolation: Make help link formatting deterministic across terminal capabilities.
vi.mock("../../../packages/terminal-core/src/links.js", () => ({
  formatDocsLink: (_path: string, full: string) => `https://${full}`,
}));

// mock-isolation: Suppress banner side effects while checking command help output.
vi.mock("../banner.js", () => ({
  formatCliBannerLine: () => "BANNER-LINE",
  hasEmittedCliBanner: () => false,
}));

// mock-isolation: Help version fixtures must not read the host checkout or packaged build metadata.
vi.mock("../../infra/git-commit.js", () => ({ resolveCommitHash: resolveCommitHashMock }));

const testProgramContext = { programVersion: "9.9.9-test" };

describe("configureProgramHelp", () => {
  let originalArgv: string[];
  let originalExitCode: NodeJS.Process["exitCode"];

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    resolveCommitHashMock.mockReturnValue("abc1234");
    vi.stubEnv("OPENCLAW_SUPPRESS_HELP_BANNER", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
  });

  function createProgram(argv: string[]) {
    process.argv = ["node", "openclaw", ...argv];
    const output = { stdout: "", stderr: "" };
    const program = new OpenClawCommand().enablePositionalOptions().exitOverride();
    configureProgramHelp(program, testProgramContext);
    program.configureOutput({
      writeOut: (value) => {
        output.stdout += stripVTControlCharacters(formatProgramHelpOutput(value));
      },
      writeErr: (value) => {
        output.stderr += stripVTControlCharacters(value);
      },
    });
    return { program, output };
  }

  async function parseHelp(argv: string[]) {
    const { program, output } = createProgram(argv);
    program
      .command("plugins")
      .command("list")
      .action(() => {});
    const error = await program.parseAsync(process.argv).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CommanderError);
    expect(error).toMatchObject({ exitCode: 0 });
    expect(output.stderr).toBe("");
    return output.stdout;
  }

  it("renders group help through both flag and help-command entrypoints", async () => {
    const groupHelp = await parseHelp(["plugins", "--help"]);
    expect(groupHelp).toContain("Usage: openclaw plugins [options] [command]");
    expect(await parseHelp(["help", "plugins"])).toBe(groupHelp);
  });

  it("formats parse errors from the exact Commander command path", async () => {
    const { program, output } = createProgram([]);
    program
      .command("plugins")
      .option("--source <source>")
      .command("list")
      .action(() => {});

    for (const args of [
      ["plugins", "--source", "list", "list", "--wat"],
      ["plugins", "lis"],
    ]) {
      process.argv = ["node", "openclaw", ...args];
      expect(
        await program.parseAsync(process.argv).catch((error: unknown) => error),
      ).toBeInstanceOf(CommanderError);
    }

    expect(output.stderr).toContain("Try: openclaw plugins list --help");
    expect(output.stderr).not.toContain("openclaw plugins list list --help");
    expect(output.stderr).toContain("Did you mean this?\n  openclaw plugins list\n");
  });

  it.each<[string, string | null]>([
    [" trace ", "trace"],
    ["loud", null],
  ])("parses --log-level %p", async (input, expected) => {
    const { program } = createProgram(["--log-level", input]);
    program.action(() => {});
    if (expected) {
      await program.parseAsync(process.argv);
      expect(program.opts().logLevel).toBe(expected);
    } else {
      await expect(program.parseAsync(process.argv)).rejects.toMatchObject({
        code: "commander.invalidArgument",
        exitCode: 1,
        message: expect.stringContaining("Invalid --log-level"),
      });
    }
  });

  it("suppresses banner formatting when parent default help requests it", async () => {
    process.env.OPENCLAW_SUPPRESS_HELP_BANNER = "1";
    const { program, output } = createProgram(["channels"]);
    program.outputHelp();
    expect(output.stdout).not.toContain("BANNER-LINE");
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

  describe("root help", () => {
    let text = "";
    beforeEach(() => {
      vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", undefined);
      text = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        text += String(chunk);
        return true;
      });
    });

    it("renders plugins using the supplied isolated config and env", async () => {
      const config = { agents: { defaults: { workspace: "/tmp/openclaw-root-help-workspace" } } };
      const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-root-help-state" };
      await outputRootHelp({ config, env, pluginSdkResolution: "src" });
      expect(pluginDescriptors).toHaveBeenCalledWith(config, env, { pluginSdkResolution: "src" });
      expect(text).toContain("matrix *");
      expect(text).toContain("Hint: commands suffixed with * have subcommands");
      expect(text).toContain("models *");
      expect(text).not.toContain("status *");
      expect(text).toContain("BANNER-LINE");
      expect(text).toContain("openclaw setup --baseline");
      expect(text).toContain("https://docs.openclaw.ai/cli");
      expect(text).toContain("Support: https://community.openclaw.ai/");
    });

    it.each([undefined, "1"])(
      "loads no plugins by default and gates private QA (%s)",
      async (enabled) => {
        vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", enabled);
        await outputRootHelp();
        expect(pluginDescriptors).not.toHaveBeenCalled();
        expect(/^\s+qa(?:\s+\*)?\s+Run QA scenarios/m.test(text)).toBe(enabled === "1");
      },
    );

    it.each<[NamedCommandDescriptor[], string, string[]]>([
      [
        [
          descriptor(
            "safe-command",
            "Open \u001B]8;;https://example.test\u0007link\u001B]8;;\u0007 now\u001B[2J",
          ),
        ],
        "Open link now",
        ["\u001B]8", "\u001B[2J"],
      ],
      [
        [descriptor("visible", "Visible"), { ...descriptor("retired", "Retired"), hidden: true }],
        "visible",
        ["retired"],
      ],
      [
        [descriptor(" alpha ", "First alpha"), descriptor("alpha", "Ignored normalized duplicate")],
        "First alpha",
        ["Ignored"],
      ],
    ])("renders safe unique visible descriptors: %j", async (entries, present, absent) => {
      pluginDescriptors.mockResolvedValueOnce(entries);
      await outputRootHelp({ config: {} });
      expect(text).toContain(present);
      for (const fragment of absent) {
        expect(text).not.toContain(fragment);
      }
      if (present === "First alpha") {
        expect(text.match(/^\s+alpha\s+/gm)).toHaveLength(1);
      }
    });

    it("rejects unsafe command names before emitting help", async () => {
      pluginDescriptors.mockResolvedValueOnce([descriptor("bad\nname", "Bad")]);
      await expect(outputRootHelp({ config: {} })).rejects.toThrow(
        'Invalid CLI command name: "bad\\nname"',
      );
      expect(text).toBe("");
    });
  });
});
