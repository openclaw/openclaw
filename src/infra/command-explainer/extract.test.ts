import { describe, expect, it, vi } from "vitest";
import { Parser, Tree } from "web-tree-sitter";
import { CommandExplanationWorkLimitError, explainShellCommand } from "./extract.js";
import { getBashParserForCommandExplanation } from "./tree-sitter-runtime.js";
import type { CommandStep } from "./types.js";

function expectRisk(risks: readonly unknown[], fields: Record<string, unknown>): void {
  expect(risks).toContainEqual(expect.objectContaining(fields));
}

async function expectSourceRisk(
  source: string,
  fields: Record<string, unknown>,
  sourceText?: string,
) {
  const explanation = await explainShellCommand(source);
  expectRisk(
    explanation.risks.map((risk) => ({
      ...risk,
      sourceText: source.slice(risk.span.startIndex, risk.span.endIndex),
    })),
    { ...fields, ...(sourceText === undefined ? {} : { sourceText }) },
  );
  return explanation;
}

function expectCommand(commands: readonly CommandStep[], argv: string[]): void {
  expect(commands).toEqual([expect.objectContaining({ executable: argv[0], argv })]);
}

function expectExecutables(commands: readonly CommandStep[], executables: string[]): void {
  expect(commands.map((step) => step.executable)).toEqual(executables);
}

async function expectDynamicExecutable(source: string, text: string): Promise<void> {
  const explanation = await expectSourceRisk(source, { kind: "dynamic-executable" }, text);
  expect(explanation.topLevelCommands).toStrictEqual([]);
}

describe("command explainer tree-sitter runtime", () => {
  it("bounds live native trees across concurrent wrapper explanations", async () => {
    const liveTrees = new Set<Tree>();
    let peakLiveTrees = 0;
    // oxlint-disable typescript/unbound-method -- The spies invoke both native methods with their original receiver below.
    const parse = Parser.prototype.parse;
    const deleteTree = Tree.prototype.delete;
    // oxlint-enable typescript/unbound-method
    const parseSpy = vi.spyOn(Parser.prototype, "parse").mockImplementation(function (
      this: Parser,
      ...args
    ) {
      const tree = parse.apply(this, args);
      if (tree) {
        liveTrees.add(tree);
        peakLiveTrees = Math.max(peakLiveTrees, liveTrees.size);
      }
      return tree;
    });
    const deleteSpy = vi.spyOn(Tree.prototype, "delete").mockImplementation(function (this: Tree) {
      deleteTree.call(this);
      liveTrees.delete(this);
    });
    try {
      const explanations = await Promise.all(
        Array.from({ length: 4 }, () => explainShellCommand(`bash -c 'sh -c "echo hello"'`)),
      );
      expect(explanations.every((explanation) => explanation.ok)).toBe(true);
      expect(liveTrees.size).toBe(0);
      // The outer command and two nested wrapper payloads share one native-memory lifetime.
      expect(peakLiveTrees).toBeGreaterThan(0);
      expect(peakLiveTrees).toBeLessThanOrEqual(3);
    } finally {
      parseSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it("decodes ordinary argument text only once without preparing wrapper offsets", async () => {
    await getBashParserForCommandExplanation();
    const word = "buf149_decode_once";
    // oxlint-disable-next-line typescript/unbound-method -- Called with its original receiver below.
    const charAt = String.prototype.charAt;
    let decodedCharacters = 0;
    const spy = vi.spyOn(String.prototype, "charAt").mockImplementation(function (
      this: string,
      index: number,
    ) {
      if (this === word) {
        decodedCharacters += 1;
      }
      return charAt.call(this, index);
    });
    try {
      const explanation = await explainShellCommand(`printf ${word}`);
      expectCommand(explanation.topLevelCommands, ["printf", word]);
      expect(decodedCharacters).toBe(word.length);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects oversized parser input before parsing", async () => {
    const parse = await getBashParserForCommandExplanation();
    expect(() => parse("x".repeat(128 * 1024 + 1))).toThrow(
      "Shell command is too large to explain",
    );
  });

  it.each`
    source                                           | shapes                        | executables
    ${"pnpm test && pnpm build || echo failed; pwd"} | ${["and", "or", "sequence"]}  | ${["pnpm", "pnpm", "echo", "pwd"]}
    ${"echo a\necho b"}                              | ${["sequence"]}               | ${["echo", "echo"]}
    ${"echo a & echo b"}                             | ${["background", "sequence"]} | ${["echo", "echo"]}
  `("extracts command shapes: $source", async ({ source, shapes, executables }) => {
    const explanation = await explainShellCommand(source);
    expect(explanation.shapes).toEqual(expect.arrayContaining(shapes));
    expectExecutables(explanation.topLevelCommands, executables);
  });

  it.each(["[", "[["])("extracts %s test arguments", async (bracket) => {
    const source = `${bracket} -f package.json ${bracket === "[" ? "]" : "]]"}`;
    const explanation = await explainShellCommand(source);
    expectCommand(explanation.topLevelCommands, [bracket, "-f", "package.json"]);
  });

  it("projects declaration arguments, substitutions, and dynamic argument spans", async () => {
    const source = "export COUNT=42 NEXT=$VALUE A=$(whoami)";
    const text = "NEXT=$VALUE";
    const explanation = await explainShellCommand(source);
    expectCommand(explanation.topLevelCommands, ["export", "COUNT=42", text, "A=$(whoami)"]);
    expect(explanation.nestedCommands).toEqual([
      expect.objectContaining({ context: "command-substitution", executable: "whoami" }),
    ]);
    const startIndex = source.indexOf(text);
    expectRisk(explanation.risks, {
      kind: "dynamic-argument",
      command: "export",
      text,
      span: {
        startIndex,
        endIndex: startIndex + text.length,
        startPosition: { row: 0, column: startIndex },
        endPosition: { row: 0, column: startIndex + text.length },
      },
    });
  });

  it("detects shell wrappers", async () => {
    const source = 'bash -lc "echo hi | wc -c"';
    const explanation = await explainShellCommand(source);
    expectExecutables(explanation.topLevelCommands, ["bash"]);
    expect(explanation.nestedCommands).toEqual([
      expect.objectContaining({ context: "wrapper-payload", executable: "echo" }),
      expect.objectContaining({ context: "wrapper-payload", executable: "wc" }),
    ]);
    const [wrappedEcho, wrappedWc] = explanation.nestedCommands;
    expect(source.slice(wrappedEcho?.span.startIndex, wrappedEcho?.span.endIndex)).toBe("echo hi");
    expect(source.slice(wrappedWc?.span.startIndex, wrappedWc?.span.endIndex)).toBe("wc -c");
    expect(explanation.shapes).toContain("pipeline");
    expectRisk(explanation.risks, {
      kind: "shell-wrapper",
      executable: "bash",
      flag: "-lc",
      payload: "echo hi | wc -c",
      span: expect.objectContaining({ startIndex: 0, endIndex: source.length }),
    });

    const command = "timeout 1 bash -lc 'id'";
    const wrapped = await expectSourceRisk(command, { kind: "shell-wrapper-through-carrier" });
    const wrappedId = wrapped.nestedCommands.find((step) => step.executable === "id");
    expect(wrappedId?.context).toBe("wrapper-payload");
    expect(command.slice(wrappedId?.span.startIndex, wrappedId?.span.endIndex)).toBe("id");
  });

  it.each([
    ["\\150", "h"],
    ["\\U00110000", "\\U00110000"],
    ["\\uZ", "uZ"],
  ])("decodes ANSI-C numeric escape %s", async (escape, expected) => {
    const explanation = await explainShellCommand(`printf $'${escape}'`);
    expect(explanation.topLevelCommands[0]?.argv).toEqual(["printf", expected]);
  });

  it.each([
    [String.raw`bash -c "printf \"a b\""`, ["printf", "a b"], String.raw`printf \"a b\"`],
    [
      String.raw`bash -c $'printf \u03bb\U0001F980'`,
      ["printf", "λ🦀"],
      String.raw`printf \u03bb\U0001F980`,
    ],
    ["bash -c 'printf λ🦀'", ["printf", "λ🦀"], "printf λ🦀"],
    ['bash -c "printf a\\\nb"', ["printf", "ab"], "printf a\\\nb"],
    ['bash -c "printf a\\\r\nb"', ["printf", "ab"], "printf a\\\r\nb"],
    ["bash -c 'cat <<EOF\nλ🦀\nEOF'", ["cat"], "cat"],
  ])("preserves decoded argv and wrapper source spans: %s", async (source, argv, rawCommand) => {
    const explanation = await explainShellCommand(source);
    expect(explanation.ok).toBe(true);
    expectCommand(explanation.nestedCommands, argv);
    const command = explanation.nestedCommands[0]!;
    expect(source.slice(command.span.startIndex, command.span.endIndex)).toBe(rawCommand);
    expect(command.span.startIndex).toBe(source.indexOf(rawCommand));
    expect(command.span.startPosition).toEqual({ row: 0, column: source.indexOf(rawCommand) });
  });

  it("normalizes static shell words before classifying commands", async () => {
    for (const [source, argv] of [
      ["e'c'ho a\\ b \"c d\"", ["echo", "a b", "c d"]],
      ["$'ec\\x68o' hi", ["echo", "hi"]],
    ] as const) {
      expectCommand((await explainShellCommand(source)).topLevelCommands, [...argv]);
    }
  });

  it.each`
    source                                                   | executable | payload                          | flag           | opaque
    ${'bash -euxc "echo hi"'}                                | ${"bash"}  | ${"echo hi"}                     | ${"-euxc"}     | ${false}
    ${'bash -c"echo hi"'}                                    | ${"bash"}  | ${"echo hi"}                     | ${"-cecho hi"} | ${false}
    ${"pwsh -ExecutionPolicy Bypass -Command Get-ChildItem"} | ${"pwsh"}  | ${"Get-ChildItem"}               | ${"-Command"}  | ${false}
    ${'bash -lc "$CMD"'}                                     | ${"bash"}  | ${"$CMD"}                        | ${"-lc"}       | ${true}
    ${'pwsh -Command "Get-ChildItem | Select Name"'}         | ${"pwsh"}  | ${"Get-ChildItem | Select Name"} | ${"-Command"}  | ${true}
    ${"b'a'sh -lc 'echo hi'"}                                | ${"bash"}  | ${"echo hi"}                     | ${"-lc"}       | ${false}
  `("classifies wrapper $source", async ({ source, executable, payload, flag, opaque }) => {
    const fields = { kind: "shell-wrapper", executable, payload, flag };
    const explanation = await expectSourceRisk(source, fields);
    if (opaque) {
      expect(explanation.nestedCommands).toStrictEqual([]);
    }
  });

  it("does not normalize dynamic executable names into trusted commands", async () => {
    await expectDynamicExecutable("e${CMD}ho hi", "e${CMD}ho");
    await expectDynamicExecutable('"${CMD}" hi', '"${CMD}"');
    await expectDynamicExecutable("./ec* hi", "./ec*");
    await expectDynamicExecutable("./{echo,printf} hi", "./{echo,printf}");

    const dynamicArgument = await explainShellCommand("echo ./ec*");
    expectCommand(dynamicArgument.topLevelCommands, ["echo", "./ec*"]);
    expectRisk(dynamicArgument.risks, { kind: "dynamic-argument", command: "echo", text: "./ec*" });

    await expectSourceRisk("bash $FLAGS id", {
      kind: "dynamic-argument",
      command: "bash",
      text: "$FLAGS",
    });

    const lineContinuation = await explainShellCommand("ec\\\nho hi");
    expect(lineContinuation.topLevelCommands).toStrictEqual([]);
    expectRisk(lineContinuation.risks, { kind: "line-continuation" });
    expectRisk(lineContinuation.risks, { kind: "dynamic-executable" });

    const continuedArgument = await explainShellCommand("pnpm test \\\n --filter foo");
    expectCommand(continuedArgument.topLevelCommands, ["pnpm", "test", "--filter", "foo"]);
    expectRisk(continuedArgument.risks, { kind: "line-continuation" });

    const escapedWordBoundary = await expectSourceRisk(
      "tr x\n\\id",
      { kind: "line-continuation" },
      "\n\\id",
    );
    expectCommand(escapedWordBoundary.topLevelCommands, ["tr", "x", "\nid"]);
  });

  it.each(["bash -lc 'echo &&'", "e'c'h'o hi"])("rejects invalid syntax: %s", async (source) => {
    const explanation = await expectSourceRisk(source, { kind: "syntax-error" });
    expect(explanation.ok).toBe(false);
  });

  it.each`
    source                                               | fields
    ${'find . -name "*.ts" -exec grep -n TODO {} +'}     | ${{ kind: "command-carrier", command: "find", flag: "-exec" }}
    ${'printf "%s\\n" a b | xargs -I{} sh -c "echo {}"'} | ${{ kind: "command-carrier", command: "xargs" }}
    ${"env -S 'sh -c \"id\"'"}                           | ${{ kind: "command-carrier", command: "env", flag: "-S" }}
    ${"env -iS 'sh -c \"id\"'"}                          | ${{ kind: "command-carrier", command: "env", flag: "-S" }}
    ${'env python -c "print(1)"'}                        | ${{ kind: "inline-eval", command: "python", flag: "-c" }}
    ${'eval "$OPENCLAW_CMD"'}                            | ${{ kind: "eval" }}
    ${"builtin eval 'echo hi'"}                          | ${{ kind: "eval" }}
    ${". ./some-script.sh"}                              | ${{ kind: "source", command: "." }}
    ${"alias ll='ls -l'"}                                | ${{ kind: "alias" }}
    ${'sudo sh -c "id && whoami"'}                       | ${{ kind: "shell-wrapper-through-carrier" }}
    ${"command bash -lc 'id && whoami'"}                 | ${{ kind: "shell-wrapper-through-carrier" }}
    ${'sudo bash -euxc "id && whoami"'}                  | ${{ kind: "shell-wrapper-through-carrier" }}
  `("detects risks in $source", async ({ source, fields }) => {
    await expectSourceRisk(source, fields);
  });

  it.each`
    source                          | argv                              | nested                                                    | risk
    ${"diff <(ls a) <(ls b)"}       | ${["diff", "<(ls a)", "<(ls b)"]} | ${["process-substitution:ls", "process-substitution:ls"]} | ${{ kind: "process-substitution" }}
    ${"ls() { echo hi; }; ls /tmp"} | ${["ls", "/tmp"]}                 | ${["function-definition:echo"]}                           | ${{ kind: "function-definition", name: "ls" }}
  `("separates nested command context: $source", async ({ source, argv, nested, risk }) => {
    const explanation = await expectSourceRisk(source, risk);
    expectCommand(explanation.topLevelCommands, argv);
    expect(explanation.topLevelCommands[0]?.context).toBe("top-level");
    expect(explanation.nestedCommands.map((step) => `${step.context}:${step.executable}`)).toEqual(
      nested,
    );
  });

  it("marks redirects heredocs and here-strings as risks", async () => {
    const source = "echo hi > out.txt";
    const redirect = await explainShellCommand(source);
    const redirectRisks = redirect.risks.filter((risk) => risk.kind === "redirect");
    expect(redirectRisks).toHaveLength(1);
    const span = redirectRisks[0]?.span;
    expect(source.slice(span?.startIndex, span?.endIndex)).toBe("> out.txt");

    await expectSourceRisk("cat <<EOF\nhello\nEOF", { kind: "heredoc" });
    await expectSourceRisk('cat <<< "hello"', { kind: "here-string" });
  });

  it.each([
    ["x=$((y)); :", true],
    ["x=${z:y}; :", true],
    ["x=${!y}; :", true],
    ['x="${y@P}"; :', true],
    ["x=(${arr[y]}); :", true],
    ["x[y]=1; :", true],
    ["x=([y]=1); :", true],
    ["x=([y]+=1); :", true],
    ["x+=([y]=1); :", true],
    ["x=([0]=1); :", true],
    ["x=(one two); :", false],
    ["x=$HOME; :", false],
    ["x='$((y))'; :", false],
    ["x=$((y)) env", false],
    ["declare x=${y:z}", false],
  ])("marks recursively evaluated standalone assignments: %s", async (source, flagged) => {
    const explanation = await explainShellCommand(source);
    expect(explanation.risks.some((risk) => risk.kind === "dynamic-assignment")).toBe(flagged);
  });

  it.each`
    name                       | source                                                                     | executable
    ${"command substitutions"} | ${"$( ".repeat(5_000) + "/approve abc123 allow-once" + " )".repeat(5_000)} | ${"/approve"}
    ${"test expressions"}      | ${`[[ ${"! ".repeat(15_000)}x ]]`}                                         | ${"[["}
  `("walks deeply nested $name without overflowing", async ({ source, executable }) => {
    const explanation = await explainShellCommand(source);
    expect(explanation.ok).toBe(true);
    expect([...explanation.topLevelCommands, ...explanation.nestedCommands]).toContainEqual(
      expect.objectContaining({ executable }),
    );
  });

  it("rejects syntax trees beyond the explanation work limit without returning partial data", async () => {
    const source = "$( ".repeat(11_000) + "echo hi" + " )".repeat(11_000);
    await expect(explainShellCommand(source)).rejects.toThrow(CommandExplanationWorkLimitError);
  });
});
