import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-test-mock-exports.mts";
import { scanClosedMockFactories } from "../../scripts/lib/mock-factory-scan.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    env: createNestedGitEnv(),
    stdio: "ignore",
  });
}

describe("first-party mock export ratchet", () => {
  it("distinguishes real module pass-through, isolation, and closed or unproven factories", () => {
    const mock = (factory: string, expected = 1, method = "mock"): [string, number] => [
      `vi.${method}("./value.js", ${factory});`,
      expected,
    ];
    const body = (code: string, expected = 1, method = "mock") =>
      mock(`async original => {${code}}`, expected, method);
    const cases: [string, number][] = [
      mock("() => ({ read: vi.fn() })"),
      mock("async original => ({...await original(), read: vi.fn()})", 0),
      mock("async original => ({...original()})"),
      body("const actual = original(); return {...actual};"),
      body("let result = {...await original()}; result = {}; return result;"),
      [
        'let factory = async original => ({...await original()}); factory = () => ({}); vi.doMock("./value.js", factory);',
        1,
      ],
      mock("original => original()", 0),
      body("const actual = original(); return actual;", 0),
      body(" original = fake; return {...await original()}; "),
      body(" ({original} = fake); return {...await original()}; "),
      body(" for (original of fakes) {} return {...await original()}; "),
      body(" for (var original of [fake]) {} return await original(); ", 1, "doMock"),
      body(" if (flag) { var original = fake; } return await original(); ", 1, "doMock"),
      body(" for (let original of [fake]) {} return await original(); ", 0, "doMock"),
      body(
        " const replace = () => { original = fake; }; replace(); return {...await original()}; ",
      ),
      body(
        ' const actual = await original(); switch (mode) { case "fake": const actual = {}; return {...actual}; } return {...actual}; ',
      ),
      body(
        ' const actual = await original(); switch (mode) { case "real": const unrelated = 1; return {...actual, unrelated}; } return {...actual}; ',
        0,
      ),
      [
        'function factory(original) { return original(); } factory = () => ({}); vi.doMock("./value.js", factory);',
        1,
      ],
      mock(
        'async () => { const actual = await vi.importActual("./value.js"); return {...actual, read: vi.fn()}; }',
        0,
      ),
      mock('async () => ({...await vi.importActual("./different.js"), read: vi.fn()})'),
      ['const fake={read: vi.fn()}; vi.mock("./value.js", () => ({...fake}));', 1],
      mock("importedFactory"),
      ['vi.mock("./value.js");', 0],
      mock("{spy: true}", 0),
      [
        'vi.mock(import("./value.js"), async original => ({...await original(), read: vi.fn()}));',
        0,
      ],
      [
        '// mock-isolation: real module boots a database\nvi.mock("./value.js", () => ({read: vi.fn()}));',
        0,
      ],
      ['// mock-isolation: \nvi.mock("./value.js", () => ({read: vi.fn()}));', 1],
      ['function factory() { return {read: vi.fn()}; } vi.doMock("./value.js", factory);', 1],
      [
        'const factory = async () => ({...await vi.importActual("./value.js")}); vi.mock("./value.js",factory);',
        0,
      ],
      mock(
        'async () => { const vi = { importActual: async () => ({}) }; return {...await vi.importActual("./value.js")}; }',
      ),
      body(" if (flag) return; return {...await original()}; "),
      ['vi.mock("third-party", () => ({read: vi.fn()}));', 0],
      body("const actual=await original(); if (flag) return {...actual}; return {read: vi.fn()};"),
      body("const actual=await original(); const copy={...actual}; return copy;", 0),
      body("const actual=await original(); {const actual={}; return {...actual};}"),
      body(" {const {original} = fake; return {...await original()};} "),
      body(" const actual = await original(); {const {actual} = fake; return {...actual};} "),
      body(" try { throw fake; } catch (original) { return {...await original()}; } "),
      body(" for (const original of fake) { return {...await original()}; } "),
      body(" const {member} = await original(); return {...member}; "),
      body(" const actual = await original(); {class actual {} return {...actual};} "),
      ['import { vi as mocker } from "vitest"; mocker.mock("./value.js", () => ({}));', 1],
      [
        'const source = \'vi.mock("./value.js", () => ({}));\'; // vi.mock("./value.js", () => ({}));',
        0,
      ],
    ];
    using parser = createNativeTypeScriptParser();
    const syntax = parser.parseSourceFiles(
      cases.map(([text], index) => ({ fileName: `fixture-${index}.ts`, text })),
    );
    syntax.forEach((file, index) => {
      expect(
        scanClosedMockFactories(file, (specifier) =>
          specifier.startsWith(".") ? [specifier] : [],
        ),
        cases[index]![0],
      ).toHaveLength(cases[index]![1]);
    });
  });

  it("blocks new exact sites and baseline expansion, honors the index, and only prunes debt", () => {
    const root = temporary.make("openclaw-mock-exports-");
    const write = (file: string, text: string) => fs.writeFileSync(file, text);
    for (const dir of ["config", "src", "test"]) {
      fs.mkdirSync(path.join(root, dir));
    }
    const baseline = path.join(root, "config/test-mock-exports-baseline.txt");
    const readBaseline = () => fs.readFileSync(baseline, "utf8");
    const entries = (text: string) => text.split("\n").filter((line) => line.startsWith("["));
    const file = path.join(root, "test/example.test.ts");
    const manifest = JSON.stringify({ name: "example", exports: { "./value": "./src/value.ts" } });
    write(path.join(root, "package.json"), manifest);
    write(path.join(root, "src/value.ts"), "export const read = () => 1;");
    const original = 'vi.mock("example/value", () => ({ read: vi.fn() }));\n';
    write(file, original);
    const indirectFile = path.join(root, "test/indirect.test.ts");
    const indirect = [
      'const factory = () => ({read: vi.fn()}); vi.mock("example/value", factory);',
      'let mutableFactory = () => ({mutableRead: vi.fn()}); vi.doMock("example/value", mutableFactory);',
      'let assignedFactory; const replacement = () => ({assignedRead: vi.fn()}); assignedFactory = replacement; vi.doMock("example/value", assignedFactory);',
    ].join("\n");
    write(indirectFile, indirect);
    git(root, "init");
    git(root, "add", ".");
    git(root, "commit", "-m", "initial source");
    git(root, "tag", "before-baseline");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    git(root, "add", ".");
    git(root, "commit", "-m", "initial approved baseline");
    const approved = readBaseline();
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    for (const property of ["read", "mutableRead", "assignedRead"]) {
      write(indirectFile, indirect.replace(`${property}: vi.fn()`, "replacement: vi.fn()"));
      expect(main(root, ["--base", "HEAD"])).toBe(1);
    }
    write(indirectFile, indirect + "\nmutableFactory = () => ({replacement: vi.fn()});");
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    write(indirectFile, indirect);

    write(file, original.replace("read: vi.fn()", "\n  read: /* formatting */ vi.fn()\n"));
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    write(file, original + original);
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(1);
    expect(main(root, ["--base", "before-baseline", "--prune"])).toBe(1);
    expect(readBaseline()).toBe(approved);
    git(root, "add", ".");
    write(file, original);
    write(path.join(root, "package.json"), JSON.stringify({ name: "example", exports: {} }));
    errors.length = 0;
    expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
    expect(errors.join("\n")).toContain("test/example.test.ts:2: example/value");
    write(path.join(root, "package.json"), manifest);
    git(root, "add", ".");

    const alternate = path.join(root, "src/alternate.ts");
    write(alternate, "export const read = () => 2;");
    write(
      path.join(root, "package.json"),
      JSON.stringify({ name: "example", exports: { "./value": "./src/alternate.ts" } }),
    );
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    write(path.join(root, "package.json"), manifest);
    fs.rmSync(alternate);

    const other = path.join(root, "test/new.test.ts");
    write(other, original);
    const entry = entries(approved)[0]!;
    fs.appendFileSync(
      baseline,
      entry.replace('"test/example.test.ts"', '"test/new.test.ts"') + "\n",
    );
    errors.length = 0;
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(1);
    expect(errors.join("\n")).toContain("baseline may only shrink");
    expect(main(root, ["--base", "before-baseline"])).toBe(1);

    fs.rmSync(other);
    fs.rmSync(indirectFile);
    write(baseline, approved);
    write(file, "// mock-isolation: preserve a database-free fixture\n" + original);
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    expect(entries(readBaseline())).toEqual([]);
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    write(
      file,
      'vi.mock("example/value", async () => ({...await vi.importActual("../src/value.js")}));',
    );
    expect(main(root, ["--base", "HEAD"])).toBe(0);
  });
});
