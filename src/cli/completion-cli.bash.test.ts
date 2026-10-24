import "../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { registerCompletionCli } from "./completion-cli.js";
import {
  createDocumentedCompletionProgram,
  runBashCompletionScript,
  runGeneratedBashCompletion,
} from "./completion-cli.test-support.js";
import { createProgramContext } from "./program/context.js";
import { setProgramContext } from "./program/program-context.js";

describe.skipIf(process.platform === "win32")("registered completion --shell bash", () => {
  let script: string;

  beforeAll(async () => {
    const program = new Command().name("openclaw");
    setProgramContext(program, createProgramContext());
    registerCompletionCli(program);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await withEnvAsync({ OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS: "1" }, () =>
        program.parseAsync(["completion", "--shell", "bash"], { from: "user" }),
      );
      script = stdout.mock.calls.map(([chunk]) => chunk.toString()).join("");
    } finally {
      stdout.mockRestore();
    }
  });

  describe.each(process.platform === "darwin" ? ["/bin/bash", "bash"] : ["bash"])(
    "%s callback",
    (bashPath) => {
      it.each([
        [["openclaw", "cron", "show", "--", "--j"], []],
        [["openclaw", "--", "g"], ["gateway"]],
        [["openclaw", "gateway", "--token", "--", "status", "--j"], ["--json"]],
        [["openclaw", "completion", "-ys", "--", "--s"], ["--shell"]],
        [["openclaw", "completion", "-ysbash", "--", "--s"], []],
        [["openclaw", "gateway", "stability", "--bundle", "--", "--j"], []],
        [["openclaw", "gateway", "stability", "--bundle", "--token", "--", "--j"], ["--json"]],
      ])("honors option operands and terminators in %j", (words, expected) => {
        expect(runBashCompletionScript(script, words, { bashPath })).toEqual(expected);
      });
    },
  );
});

describe("completion-cli native Bash words", () => {
  it.skipIf(process.platform !== "darwin")("uses macOS Bash byte offsets in a UTF-8 locale", () => {
    const prefix = "openclaw gateway --token=é status --j";

    expect(
      runGeneratedBashCompletion(
        createDocumentedCompletionProgram(),
        ["openclaw", "gateway", "--token=é", "status", "--json"],
        {
          line: `${prefix}son`,
          word: "--j",
          point: Buffer.byteLength(prefix),
          bashPath: "/bin/bash",
          env: { ...process.env, LC_ALL: "en_US.UTF-8" },
        },
      ),
    ).toEqual(["--json"]);
  });

  it
    .skipIf(process.platform === "win32")
    .each([
      ["completion --shell=", "completion --shell =", "", ["zsh", "bash", "powershell", "fish"]],
      ["completion --shell=fish", "completion --shell=fish", "f", ["fish"], 29],
      ["completion --sh=fish", "completion --sh=fish", "--sh", ["--shell"], 24],
      ["completion -ysfish", "completion -ysfish", "-ysf", ["-ysfish"], 24],
      [
        "--profile=gateway completion --shell=fish --yes",
        "--profile = gateway completion --shell = fish --yes",
        "f",
        ["fish"],
        47,
        7,
      ],
      ["completion --shell=fish", "completion --shell=fish", "comple", ["completion"], 15, 1],
      ["gateway --token = status --j", "gateway --token = status --j", "--j", ["--json"]],
      ["completion>/dev/null --shell f", "completion > /dev/null --shell f", "f", ["fish"]],
      [
        "gateway --token=prefix:status --f",
        "gateway --token = prefix : status --f",
        "--f",
        ["--force"],
      ],
      ...['"f"', "\\f", 'f"i'].map((value): NativeWordsCase => [
        `completion --shell ${value}`,
        `completion --shell ${value}`,
        value === 'f"i' ? "i" : value,
        [value === 'f"i' ? "ish" : "fish"],
      ]),
      ["completion --shell='f", "completion --shell = 'f", "f", ["fish"]],
      ['completion -s "f', 'completion -s "f', "f", ["fish"]],
    ] satisfies NativeWordsCase[])(
    "respects native Bash word boundaries in %s",
    (line, words, word, expected, point, cword) => {
      const program = createDocumentedCompletionProgram().option("--profile <name>", "Profile");
      expect(
        runGeneratedBashCompletion(program, ["openclaw", ...words.split(" ")], {
          line: `openclaw ${line}`,
          word,
          point,
          cword,
        }),
      ).toEqual(expected);
    },
  );
});

type NativeWordsCase = [
  line: string,
  words: string,
  word: string,
  expected: string[],
  point?: number,
  cword?: number,
];
