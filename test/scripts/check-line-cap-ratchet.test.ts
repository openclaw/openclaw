import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-line-cap-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const errors = vi.fn<typeof console.error>();
beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  errors.mockClear();
  vi.spyOn(console, "error").mockImplementation(errors);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function git(root: string, ...args: string[]) {
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function source(lines: number) {
  return Array.from({ length: lines }, (_, i) => `export const value${i} = ${i};\n`).join("");
}

const check = (root: string, ...args: string[]) => main(root, ["--base", "HEAD", ...args]);
function write(root: string, content: number | string, file = "src/file.ts") {
  fs.writeFileSync(path.join(root, file), typeof content === "number" ? source(content) : content);
}
function expectSource(root: string, content: number | string, code: number, file = "src/file.ts") {
  write(root, content, file);
  expect(check(root)).toBe(code);
}
const expectGrowth = (file = "src/file.ts", from = 5, to = 6) =>
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining(`${file}: ${from} -> ${to} counted lines (cap 3)`),
  );

function fixture(lines = 5, severity = "warn", ignorePatterns: string[] = []) {
  const root = tempDirs.make("openclaw-line-cap-test-");
  fs.mkdirSync(path.join(root, "src"));
  const rules = { "max-lines": [severity, { max: 3, skipBlankLines: true, skipComments: true }] };
  const override = { files: ["**/*.ts"], excludeFiles: ["**/generated/**"], rules };
  write(root, JSON.stringify({ ignorePatterns, overrides: [override] }), ".oxlintrc.json");
  write(root, lines);
  git(root, "init");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

it("warns for CI growth, writes the summary, and still rejects broken source", () => {
  const root = fixture();
  const summary = path.join(root, "summary.md");
  expectSource(root, 6, 1);
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
  expect(check(root)).toBe(0);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("::warning file=src/file.ts,line=1,col=0,"),
  );
  expect(fs.readFileSync(summary, "utf8")).toContain("5 -&gt; 6 counted lines");
  expectSource(root, "export const = broken;", 1);
});

it("measures ignored repository-contained scratch while preserving explicit exclusions", () => {
  const root = fixture(5, "warn", ["src/ignored/**"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".artifacts/\n");
  const scratch = path.join(root, ".artifacts", "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  vi.stubEnv("TMPDIR", scratch);
  vi.stubEnv("TMP", scratch);
  vi.stubEnv("TEMP", scratch);
  expectSource(root, 6, 1);
  expectGrowth();
  write(root, 4);
  for (const directory of ["ignored", "generated"]) {
    fs.mkdirSync(path.join(root, "src", directory));
    fs.writeFileSync(path.join(root, "src", directory, "excluded.ts"), source(8));
  }
  errors.mockClear();
  expect(check(root)).toBe(0);
  expect(errors).not.toHaveBeenCalled();
});

it("ratchets error diagnostics in JetBrains terminals across renames, staged and untracked sources", () => {
  vi.stubEnv("TERMINAL_EMULATOR", "JetBrains-JediTerm");
  const root = fixture(5, "error");
  const scratch = tempDirs.make("openclaw-line-cap-scratch-");
  const scratchAlias = path.join(root, "scratch-alias");
  fs.symlinkSync(scratch, scratchAlias, process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", scratchAlias);
  expectSource(root, source(5) + "// changed comment\n", 0);
  const renamed = "src/renamed space #%.ts";
  git(root, "mv", "src/file.ts", renamed);
  expectSource(root, source(4) + "\n/* comment\n comment */\n", 0, renamed);
  write(root, 6, renamed);
  git(root, "add", ".");
  write(root, 4, renamed);
  expect(check(root, "--staged")).toBe(1);
  expectGrowth(renamed);
  expect(check(root)).toBe(0);
  expectSource(root, 4, 1, "src/new.ts");
  expectGrowth("src/new.ts", 3, 4);
});

it("handles repaired under-cap head without relaxing the head check", () => {
  const root = fixture(2);
  write(root, "const duplicate = 1;\nconst duplicate = 2;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "broken base");
  expectSource(root, 3, 0);
  expect(errors).not.toHaveBeenCalled();
});

it("does not hydrate historical blobs for under-cap repairs in a partial clone", () => {
  const origin = fixture();
  git(origin, "config", "uploadpack.allowFilter", "true");
  write(origin, 3);
  git(origin, "commit", "-am", "repair");
  const root = path.join(tempDirs.make("openclaw-line-cap-partial-"), "clone");
  git(origin, "clone", "--filter=blob:none", pathToFileURL(origin).href, root);
  const packs = path.join(root, ".git", "objects", "pack");
  const before = fs.readdirSync(packs).filter((file) => file.endsWith(".pack"));
  expect(main(root, ["--base", "HEAD~"])).toBe(0);
  expect(fs.readdirSync(packs).filter((file) => file.endsWith(".pack"))).toEqual(before);
});

it("counts oxlint-suppressed debt without changing the source", () => {
  const root = fixture();
  const directive = "/* oxlint-disable max-lines -- inherited debt */\n";
  write(root, directive + source(5));
  git(root, "add", ".");
  git(root, "commit", "-m", "inherited suppression");
  expectSource(root, directive + source(4), 0);
  const growing = directive + source(6);
  expectSource(root, growing, 1);
  expectGrowth();
  expect(fs.readFileSync(path.join(root, "src/file.ts"), "utf8")).toBe(growing);
});
