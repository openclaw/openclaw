import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { registerCompletionCli } from "./completion-cli.js";
import {
  createDocumentedCompletionProgram,
  runGeneratedBashCompletion,
} from "./completion-cli.test-support.js";
import { createProgramContext } from "./program/context.js";
import { setProgramContext } from "./program/program-context.js";
import { quoteCliArg } from "./quote-cli-arg.js";

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
        [["openclaw", "completion", "--", "--shell", "f"], []],
        [["openclaw", "--", "g"], ["gateway"]],
        [["openclaw", "cron", "--", "sh"], ["show"]],
        [["openclaw", "capability", "--", "emb"], ["embedding"]],
        [["openclaw", "gateway", "--token", "--", "status", "--j"], ["--json"]],
        [["openclaw", "gateway", "--token=--", "status", "--j"], ["--json"]],
        [["openclaw", "completion", "-ys", "--", "--s"], ["--shell"]],
        [["openclaw", "completion", "-ysbash", "--", "--s"], []],
        [["openclaw", "message", "send", "-mt", "--", "--j"], []],
        [["openclaw", "gateway", "stability", "--bundle", "--", "--j"], []],
        [["openclaw", "gateway", "stability", "--bundle", "latest", "--", "--j"], []],
        [["openclaw", "gateway", "stability", "--bundle", "--token", "--", "--j"], ["--json"]],
        [["openclaw", "cron", "show", "'--'", "--j"], []],
        [["openclaw", "cron", "show", "\\--", "--j"], []],
      ])("honors option operands and terminators in %j", (words, expected) => {
        const result = spawnSync(bashPath, ["--noprofile", "--norc"], {
          encoding: "utf8",
          input: `${script}
COMP_WORDS=(${words.map(quoteCliArg).join(" ")})
COMP_CWORD=${words.length - 1}
COMP_LINE=${quoteCliArg(words.join(" "))}
COMP_POINT=\${#COMP_LINE}
_openclaw_completion openclaw "\${COMP_WORDS[COMP_CWORD]}"
printf '%s\\n' "\${COMPREPLY[@]}"
`,
        });
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout.split("\n").filter(Boolean)).toEqual(expected);
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

  it.skipIf(process.platform === "win32").each([
    {
      line: "openclaw completion --shell=",
      words: ["openclaw", "completion", "--shell", "="],
      word: "",
      expected: ["zsh", "bash", "powershell", "fish"],
    },
    {
      line: "openclaw --profile=gateway completion --shell f",
      words: ["openclaw", "--profile", "=", "gateway", "completion", "--shell", "f"],
      word: "f",
      expected: ["fish"],
    },
    {
      line: "openclaw completion --shell=f",
      words: ["openclaw", "completion", "--shell=f"],
      word: "f",
      expected: ["fish"],
    },
    {
      line: "openclaw completion --shell=fish",
      words: ["openclaw", "completion", "--shell", "=", "fish"],
      word: "f",
      point: 29,
      expected: ["fish"],
    },
    {
      line: "openclaw completion --shell=fish",
      words: ["openclaw", "completion", "--shell=fish"],
      word: "f",
      point: 29,
      expected: ["fish"],
    },
    {
      line: "openclaw completion --shell=fish",
      words: ["openclaw", "completion", "--shell", "=", "fish"],
      word: "",
      point: 28,
      expected: ["zsh", "bash", "powershell", "fish"],
    },
    {
      line: "openclaw completion --shell=bogus",
      words: ["openclaw", "completion", "--shell", "=", "bogus"],
      word: "b",
      point: 29,
      expected: ["bash"],
    },
    {
      line: "openclaw completion --sh=fish",
      words: ["openclaw", "completion", "--sh=fish"],
      word: "--sh",
      point: 24,
      expected: ["--shell"],
    },
    {
      line: "openclaw completion -ysfish",
      words: ["openclaw", "completion", "-ysfish"],
      word: "-ysf",
      point: 24,
      expected: ["-ysfish"],
    },
    {
      line: "openclaw --profile=gateway completion --shell=fish --yes",
      words: [
        "openclaw",
        "--profile",
        "=",
        "gateway",
        "completion",
        "--shell",
        "=",
        "fish",
        "--yes",
      ],
      word: "f",
      point: 47,
      cword: 7,
      expected: ["fish"],
    },
    {
      line: "openclaw completion --shell=fish",
      words: ["openclaw", "completion", "--shell=fish"],
      word: "comple",
      point: 15,
      cword: 1,
      expected: ["completion"],
    },
    {
      line: "openclaw gateway --token = status --j",
      words: ["openclaw", "gateway", "--token", "=", "status", "--j"],
      word: "--j",
      expected: ["--json"],
    },
    {
      line: "openclaw completion>/dev/null --shell f",
      words: ["openclaw", "completion", ">", "/dev/null", "--shell", "f"],
      word: "f",
      expected: ["fish"],
    },
    {
      line: "openclaw gateway --token=prefix:status --f",
      words: ["openclaw", "gateway", "--token", "=", "prefix", ":", "status", "--f"],
      word: "--f",
      expected: ["--force"],
    },
    {
      line: "openclaw gateway --token=foo==status --f",
      words: ["openclaw", "gateway", "--token", "=", "foo", "==", "status", "--f"],
      word: "--f",
      expected: ["--force"],
    },
    ...['"f', "'f", '"f"', "\\f", 'f"i'].map((value) => ({
      line: `openclaw completion --shell ${value}`,
      words: ["openclaw", "completion", "--shell", value],
      word: value === 'f"i' ? "i" : value === '"f' || value === "'f" ? "f" : value,
      expected: [value === 'f"i' ? "ish" : "fish"],
    })),
    ...['"', "'"].flatMap((quote) => [
      {
        line: `openclaw completion --shell=${quote}f`,
        words: ["openclaw", "completion", `--shell=${quote}f`],
        word: "f",
        expected: ["fish"],
      },
      {
        line: `openclaw completion --shell=${quote}f`,
        words: ["openclaw", "completion", "--shell", "=", `${quote}f`],
        word: "f",
        expected: ["fish"],
      },
      {
        line: `openclaw completion -s ${quote}f`,
        words: ["openclaw", "completion", "-s", `${quote}f`],
        word: "f",
        expected: ["fish"],
      },
    ]),
  ])("respects native Bash word boundaries in $line at $point", ({ words, expected, ...input }) => {
    const program = createDocumentedCompletionProgram().option("--profile <name>", "Profile");

    expect(runGeneratedBashCompletion(program, words, input)).toEqual(expected);
  });
});
