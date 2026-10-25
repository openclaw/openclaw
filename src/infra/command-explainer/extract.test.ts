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

function expectShellWrapper(source: string, executable: string, payload: string, flag?: string) {
  return expectSourceRisk(source, {
    kind: "shell-wrapper",
    executable,
    payload,
    ...(flag === undefined ? {} : { flag }),
  });
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

  it("rejects oversized parser input before parsing", async () => {
    const parse = await getBashParserForCommandExplanation();
    expect(() => parse("x".repeat(128 * 1024 + 1))).toThrow(
      "Shell command is too large to explain",
    );
  });

  it("separates process substitution commands", async () => {
    const explanation = await explainShellCommand("diff <(ls a) <(ls b)");
    expectExecutables(explanation.topLevelCommands, ["diff"]);
    expect(explanation.nestedCommands.map((step) => `${step.context}:${step.executable}`)).toEqual([
      "process-substitution:ls",
      "process-substitution:ls",
    ]);
    expect(explanation.risks.map((risk) => risk.kind)).toContain("process-substitution");
  });

  it("detects AND OR and sequence shapes", async () => {
    const explanation = await explainShellCommand("pnpm test && pnpm build || echo failed; pwd");
    expect(explanation.shapes).toEqual(expect.arrayContaining(["and", "or", "sequence"]));
    expectExecutables(explanation.topLevelCommands, ["pnpm", "pnpm", "echo", "pwd"]);
  });

  it("detects newline sequences and background commands", async () => {
    for (const [source, shapes] of [
      ["echo a\necho b", ["sequence"]],
      ["echo a & echo b", ["background", "sequence"]],
    ] as const) {
      const explanation = await explainShellCommand(source);
      expect(explanation.shapes).toEqual(expect.arrayContaining(shapes));
      expectExecutables(explanation.topLevelCommands, ["echo", "echo"]);
    }
  });

  it("detects declaration and test command forms", async () => {
    const declaration = await explainShellCommand("export A=$(whoami)");
    expectCommand(declaration.topLevelCommands, ["export", "A=$(whoami)"]);
    expect(declaration.nestedCommands).toEqual([
      expect.objectContaining({ context: "command-substitution", executable: "whoami" }),
    ]);

    for (const bracket of ["[", "[["]) {
      const source = `${bracket} -f package.json ${bracket === "[" ? "]" : "]]"}`;
      const explanation = await explainShellCommand(source);
      expectCommand(explanation.topLevelCommands, [bracket, "-f", "package.json"]);
    }
  });

  it("projects declaration arguments and dynamic argument spans", async () => {
    const source = "export COUNT=42 NEXT=$VALUE";
    const text = "NEXT=$VALUE";
    const explanation = await explainShellCommand(source);
    expect(explanation.topLevelCommands[0]?.argv).toEqual(["export", "COUNT=42", text]);
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

    for (const command of [
      "time bash -lc 'id'",
      "nice bash -lc 'id'",
      "timeout 1 bash -lc 'id'",
      "caffeinate -d -w 42 bash -lc 'id'",
    ] as const) {
      const wrapped = await explainShellCommand(command);
      expectRisk(wrapped.risks, { kind: "shell-wrapper-through-carrier" });
      const wrappedId = wrapped.nestedCommands.find((step) => step.executable === "id");
      expect(wrappedId?.context).toBe("wrapper-payload");
      expect(command.slice(wrappedId?.span.startIndex, wrappedId?.span.endIndex)).toBe("id");
    }
  });

  it.each([
    ["\\150", "h"],
    ["\\U00110000", "\\U00110000"],
    ["\\uZ", "uZ"],
  ])("decodes ANSI-C numeric escape %s", async (escape, expected) => {
    const explanation = await explainShellCommand(`printf $'${escape}'`);
    expect(explanation.topLevelCommands[0]?.argv).toEqual(["printf", expected]);
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
    source                                                   | executable | payload                          | flag          | opaque
    ${'bash -euxc "echo hi"'}                                | ${"bash"}  | ${"echo hi"}                     | ${"-euxc"}    | ${false}
    ${'bash -c"echo hi"'}                                    | ${"bash"}  | ${"echo hi"}                     | ${undefined}  | ${false}
    ${'pwsh -Command "Get-ChildItem"'}                       | ${"pwsh"}  | ${"Get-ChildItem"}               | ${"-Command"} | ${false}
    ${"pwsh -ExecutionPolicy Bypass -Command Get-ChildItem"} | ${"pwsh"}  | ${"Get-ChildItem"}               | ${"-Command"} | ${false}
    ${'bash -lc "$CMD"'}                                     | ${"bash"}  | ${"$CMD"}                        | ${"-lc"}      | ${true}
    ${'pwsh -Command "Get-ChildItem | Select Name"'}         | ${"pwsh"}  | ${"Get-ChildItem | Select Name"} | ${"-Command"} | ${true}
    ${"b'a'sh -lc 'echo hi'"}                                | ${"bash"}  | ${"echo hi"}                     | ${"-lc"}      | ${false}
  `("classifies wrapper $source", async ({ source, executable, payload, flag, opaque }) => {
    const explanation = await expectShellWrapper(source, executable, payload, flag);
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
    ${'sudo python -c "print(1)"'}                       | ${{ kind: "inline-eval", command: "python", flag: "-c" }}
    ${'command python -c "print(1)"'}                    | ${{ kind: "inline-eval", command: "python", flag: "-c" }}
    ${'exec python -c "print(1)"'}                       | ${{ kind: "inline-eval", command: "python", flag: "-c" }}
    ${'eval "$OPENCLAW_CMD"'}                            | ${{ kind: "eval" }}
    ${"builtin eval 'echo hi'"}                          | ${{ kind: "eval" }}
    ${"exec eval 'echo hi'"}                             | ${{ kind: "eval" }}
    ${". ./some-script.sh"}                              | ${{ kind: "source", command: "." }}
    ${"alias ll='ls -l'"}                                | ${{ kind: "alias" }}
    ${'sudo sh -c "id && whoami"'}                       | ${{ kind: "shell-wrapper-through-carrier" }}
    ${"command bash -lc 'id && whoami'"}                 | ${{ kind: "shell-wrapper-through-carrier" }}
    ${"exec bash -lc 'id && whoami'"}                    | ${{ kind: "shell-wrapper-through-carrier" }}
    ${'sudo bash -euxc "id && whoami"'}                  | ${{ kind: "shell-wrapper-through-carrier" }}
  `("detects risks in $source", async ({ source, fields }) => {
    await expectSourceRisk(source, fields);
  });

  it("treats function bodies as nested command context", async () => {
    const explanation = await explainShellCommand("ls() { echo hi; }; ls /tmp");
    expectCommand(explanation.topLevelCommands, ["ls", "/tmp"]);
    expect(explanation.topLevelCommands[0]?.context).toBe("top-level");
    expect(explanation.nestedCommands).toEqual([
      expect.objectContaining({ context: "function-definition", executable: "echo" }),
    ]);
    expectRisk(explanation.risks, { kind: "function-definition", name: "ls" });
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
