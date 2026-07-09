// Covers interpreter inline-eval flag detection, positional program forms, and
// allowlist pattern matching for approval policy.
import { describe, expect, it } from "vitest";
import type { InterpreterInlineEvalHit } from "./inline-eval.js";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
  isInterpreterLikeAllowlistPattern,
} from "./inline-eval.js";

function expectInlineEvalDescription(hit: InterpreterInlineEvalHit | null, expected: string) {
  if (hit === null) {
    throw new Error(`Expected inline eval hit for ${expected}`);
  }
  expect(describeInterpreterInlineEval(hit)).toBe(expected);
}

describe("exec inline eval detection", () => {
  it.each([
    { argv: ["python3", "-c", "print('hi')"], expected: "python3 -c" },
    { argv: ["python3", "-cprint('hi')"], expected: "python3 -c" },
    { argv: ["python3", "-bc", "print('hi')"], expected: "python3 -c" },
    { argv: ["python3", "-Sc", "print('hi')"], expected: "python3 -c" },
    { argv: ["python3", "-xc", "print('hi')"], expected: "python3 -c" },
    { argv: ["python3.13", "-c", "print('hi')"], expected: "python3.13 -c" },
    { argv: ["/usr/bin/pypy3.10", "-c", "print('hi')"], expected: "pypy3.10 -c" },
    { argv: ["/usr/bin/node", "--eval", "console.log('hi')"], expected: "node --eval" },
    { argv: ["/usr/bin/node", "--eval=console.log('hi')"], expected: "node --eval" },
    { argv: ["bun", "-pconsole.log('hi')"], expected: "bun -p" },
    { argv: ["deno", "--print=1 + 1"], expected: "deno --print" },
    { argv: ["ruby", "-eputs 1"], expected: "ruby -e" },
    { argv: ["ruby", "-ane", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-ce", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-ne", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-00pe", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-p00e", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-pe", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-Se", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-We", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-W2e", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-ve", "puts 1"], expected: "ruby -e" },
    { argv: ["ruby", "-we", "puts 1"], expected: "ruby -e" },
    { argv: ["perl", "-E", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Esay 1"], expected: "perl -e" },
    { argv: ["perl", "-ce", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-de", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-fe", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-l0e", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-ne", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-0777pe", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-p0777e", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Se", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Te", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-UE", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Ve", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-We", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-we", "say 1"], expected: "perl -e" },
    { argv: ["perl", "-Xe", "say 1"], expected: "perl -e" },
    { argv: ["php", "-B", "system('id');"], expected: "php -B" },
    { argv: ["php", "-rsystem('id');"], expected: "php -r" },
    { argv: ["php", "-E", "system('id');"], expected: "php -E" },
    { argv: ["php", "-R", "system('id');"], expected: "php -R" },
    { argv: ["Rscript", "-e", "system('id')"], expected: "rscript -e" },
    { argv: ["lua", "-eprint(1)"], expected: "lua -e" },
    { argv: ["osascript", "-e", "beep"], expected: "osascript -e" },
    { argv: ["osascript", '-edisplay alert "hi"'], expected: "osascript -e" },
    { argv: ["awk", "BEGIN { print 1 }"], expected: "awk inline program" },
    { argv: ["gawk", "-F", ",", "{print $1}", "data.csv"], expected: "gawk inline program" },
  ] as const)("detects interpreter eval flags for %j", ({ argv, expected }) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expectInlineEvalDescription(hit, expected);
  });

  it.each([
    { argv: ["awk", 'BEGIN{system("id")}', "/dev/null"], expected: "awk inline program" },
    {
      argv: ["awk", "-F", ",", 'BEGIN{system("id")}', "/dev/null"],
      expected: "awk inline program",
    },
    { argv: ["gawk", "-e", 'BEGIN{system("id")}', "/dev/null"], expected: "gawk -e" },
    {
      argv: ["gawk", "-f", "library.awk", '--source=BEGIN{system("id")}', "/dev/null"],
      expected: "gawk --source",
    },
    { argv: ["find", ".", "-exec", "id", "{}", ";"], expected: "find -exec" },
    { argv: ["find", "--", ".", "-exec", "id", "{}", ";"], expected: "find -exec" },
    { argv: ["find", ".", "-ok", "id", "{}", ";"], expected: "find -ok" },
    { argv: ["find", ".", "-okdir", "id", "{}", ";"], expected: "find -okdir" },
    { argv: ["xargs", "id"], expected: "xargs inline command" },
    { argv: ["xargs", "-I", "{}", "sh", "-c", "id"], expected: "xargs inline command" },
    { argv: ["xargs", "--replace", "id"], expected: "xargs inline command" },
    { argv: ["make", "-f", "evil.mk"], expected: "make -f" },
    { argv: ["make", "-E", "$(shell id)"], expected: "make -E" },
    { argv: ["make", "-E$(shell id)"], expected: "make -E" },
    { argv: ["make", "--eval=$(shell id)"], expected: "make --eval" },
    { argv: ["sed", "s/.*/id/e", "/dev/null"], expected: "sed inline program" },
    { argv: ["gsed", "-e", "s/.*/id/e", "/dev/null"], expected: "gsed -e" },
    { argv: ["sed", "-es/.*/id/e", "/dev/null"], expected: "sed -e" },
  ] as const)("detects command carriers for %j", ({ argv, expected }) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expectInlineEvalDescription(hit, expected);
  });

  it("ignores normal script execution", () => {
    expect(detectInterpreterInlineEvalArgv(["python3", "script.py"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["python3.13", "script.py"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["node", "script.js"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["node", "--evalish=console.log(1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["python3", "-Wc", "print('hi')"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["python3", "-Xc", "print('hi')"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["find", ".", "-execute", "id"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ruby", "-EUTF-8", "script.rb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ruby", "-Itest", "script.rb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ruby", "-W:deprecatede", "puts 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ruby", "-7pe", "puts 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-C0e", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-D0e", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-me", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-Me", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-7pe", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["perl", "-0xFFpe", "say 1"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["php", "-F", "filter.php"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["Rscript", "script.R"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["r2", "-e", "bin.cache=true", "program"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["awk", "-f", "script.awk", "data.csv"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["find", ".", "-name", "*.ts"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["xargs", "-0"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["make", "test"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["sed", "-f", "script.sed", "input.txt"])).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["sed", "-i", "-f", "script.sed", "input.txt"]),
    ).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["sed", "-E", "-f", "script.sed", "input.txt"]),
    ).toBeNull();
  });

  it("matches interpreter-like allowlist patterns", () => {
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/python3")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/python3.13")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("python3.*")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("pypy3.10")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/node")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("Rscript")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("r2")).toBe(false);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/awk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/gawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/mawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("nawk")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/find")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("xargs.exe")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/gmake")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/gsed")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/rg")).toBe(false);
  });
});
