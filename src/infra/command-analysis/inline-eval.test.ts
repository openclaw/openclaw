import { describe, expect, it } from "vitest";
import {
  describeInterpreterInlineEval,
  detectInterpreterInlineEvalArgv,
  isInterpreterLikeAllowlistPattern,
} from "./inline-eval.js";

function evalFlags(
  executable: string,
  flags: string,
  code: string,
  expected?: string,
): [string[], string][] {
  return flags
    .split(" ")
    .map((flag) => [
      flag.endsWith("=") ? [executable, flag + code] : [executable, flag, code],
      expected ?? `${executable} ${flag.replace(/[=]$/u, "")}`,
    ]);
}

function checkInlineEval(argv: readonly string[], expected: string) {
  const hit = detectInterpreterInlineEvalArgv([...argv]);
  expect(hit && describeInterpreterInlineEval(hit)).toBe(expected);
}

function expectNoInlineEval(argv: string[]) {
  expect(detectInterpreterInlineEvalArgv(argv)).toBeNull();
}

describe("exec inline eval detection", () => {
  it.each([
    [["python3", "-c", "print('hi')"], "python3 -c"],
    [["python3", "-cprint('hi')"], "python3 -c"],
    ...evalFlags("python3", "-bc", "print('hi')", "python3 -c"),
    [["python3.13", "-c", "print('hi')"], "python3.13 -c"],
    [["/usr/bin/pypy3.10", "-c", "print('hi')"], "pypy3.10 -c"],
    [["/usr/bin/node", "--eval", "console.log('hi')"], "node --eval"],
    [["/usr/bin/node", "--eval=console.log('hi')"], "node --eval"],
    [["bun", "-pconsole.log('hi')"], "bun -p"],
    [["deno", "--print=1 + 1"], "deno --print"],
    [["ruby", "-eputs 1"], "ruby -e"],
    ...evalFlags("ruby", "-ane -00pe -p00e -W2e", "puts 1", "ruby -e"),
    [["perl", "-E", "say 1"], "perl -e"],
    [["perl", "-Esay 1"], "perl -e"],
    ...evalFlags("perl", "-ce -l0e -0777pe -p0777e -UE", "say 1", "perl -e"),
    ...evalFlags("php", "-B -E -R", "system('id');"),
    [["php", "-rsystem('id');"], "php -r"],
    [["Rscript", "-e", "system('id')"], "rscript -e"],
    [["julia", "-e", "run(`id`)"], "julia -e"],
    [["julia", "-erun(`id`)"], "julia -e"],
    [["julia", "--eval=run(`id`)"], "julia --eval"],
    [["julia", "-E", "VERSION"], "julia -E"],
    [["julia", "-EVERSION"], "julia -E"],
    [["elixir", "-e", 'System.cmd("id", [])'], "elixir -e"],
    [["elixir", '--eval=System.cmd("id", [])'], "elixir --eval"],
    [["elixir", "--rpc-eval", "worker@127.0.0.1", 'System.cmd("id", [])'], "elixir --rpc-eval"],
    [["iex", "--rpc-eval", "worker@127.0.0.1", 'System.cmd("id", [])'], "iex --rpc-eval"],
    [["guile", "-c", '(system "id")'], "guile -c"],
    [["guile", "-e", '(lambda args (system "id"))', "/dev/null"], "guile -e"],
    [["groovy", "-e", '"id".execute()'], "groovy -e"],
    [["groovy", '-e"id".execute()'], "groovy -e"],
    ...evalFlags("groovy", "-ne -pe", '["id"].execute()', "groovy -e"),
    [["groovy", '-encoding:["id"].execute()'], "groovy -e"],
    ...evalFlags(
      "scala",
      "-e --script-snippet --execute-script --execute-sc= --execute-scala-script= --scala-snippet= --execute-scala= --java-snippet --execute-java= --markdown-snippet --md-snippet= --execute-markdown --execute-md=",
      "1",
    ),
    ...evalFlags("scala-cli", "--script-snippet", "1"),
    [["clojure", "-e", '(clojure.java.shell/sh "id")'], "clojure -e"],
    [["clj", "--eval", "(println 1)"], "clj --eval"],
    [["raku", "-e", "run 'id'"], "raku -e"],
    [["raku", "-e say 1"], "raku -e"],
    [["raku", "-ne", "run 'id'"], "raku -e"],
    [["perl6", "-pe", "run 'id'"], "perl6 -e"],
    [["ghc", "-e", 'System.Process.system "id"'], "ghc -e"],
    [["ghci", "-e", 'System.Process.system "id"'], "ghci -e"],
    [["erl", "-eval", 'os:cmd("id").'], "erl -eval"],
    [["erl", "-run", "os", "cmd", "id"], "erl -run"],
    [["erl", "-s", "os", "cmd", "id"], "erl -s"],
    [["erl", "-noshell", "-s", "init", "stop"], "erl -s"],
    [["werl", "-eval", 'os:cmd("id").'], "werl -eval"],
    [["gdb", "-ex", "shell id", "-ex", "quit"], "gdb -ex"],
    [["gdb", "-ex=shell id", "-ex", "quit"], "gdb -ex"],
    ...[
      ["-iex -iex=", "-iex"],
      ["-ev -eval -eval-c -eval-c= -eval-command -eval-command=", "-eval-command"],
      ["--ev --eval --eval-c= --eval-command=", "--eval-command"],
      ["-init-e -init-eval -init-eval-c= -init-eval-command=", "-init-eval-command"],
      ["--init-e --init-eval-command= --init-eval=", "--init-eval-command"],
      ["-eiex -eiex=", "-eiex"],
      ["-early-init-e -early-init-eval -early-init-eval-command=", "-early-init-eval-command"],
      ["--early-init-e= --early-init-eval=", "--early-init-eval-command"],
    ].flatMap(([flags, expected]) => evalFlags("gdb", flags, "shell id", `gdb ${expected}`)),
    [["expect", "-c", "spawn id"], "expect -c"],
    [["expect", "-cspawn id"], "expect -c"],
    [["lua", "-eprint(1)"], "lua -e"],
    [["osascript", "-e", "beep"], "osascript -e"],
    [["osascript", '-edisplay alert "hi"'], "osascript -e"],
  ] as const)("detects interpreter eval flags for %j", checkInlineEval);

  it.each([
    [["awk", 'BEGIN{system("id")}', "/dev/null"], "awk inline program"],
    [["awk", "-F", ",", 'BEGIN{system("id")}', "/dev/null"], "awk inline program"],
    [["gawk", "-e", 'BEGIN{system("id")}', "/dev/null"], "gawk -e"],
    [["gawk", "-f", "library.awk", '--source=BEGIN{system("id")}', "/dev/null"], "gawk --source"],
    [["gawk", "-f", "library.awk", '--s=BEGIN{system("id")}', "/dev/null"], "gawk --source"],
    [["gawk", "-f", "library.awk", '--so=BEGIN{system("id")}', "/dev/null"], "gawk --source"],
    [["gawk", "-f", "library.awk", "--sou", 'BEGIN{system("id")}', "/dev/null"], "gawk --source"],
    [["find", ".", "-exec", "id", "{}", ";"], "find -exec"],
    [["find", "--", ".", "-exec", "id", "{}", ";"], "find -exec"],
    [["find", ".", "-ok", "id", "{}", ";"], "find -ok"],
    [["find", ".", "-okdir", "id", "{}", ";"], "find -okdir"],
    [["xargs", "id"], "xargs inline command"],
    [["xargs", "-I", "{}", "sh", "-c", "id"], "xargs inline command"],
    [["xargs", "--replace", "id"], "xargs inline command"],
    [["make", "-f", "evil.mk"], "make -f"],
    [["make", "-E", "$(shell id)"], "make -E"],
    [["make", "-E$(shell id)"], "make -E"],
    [["make", "--eval=$(shell id)"], "make --eval"],
    [["make", "--ev=$(shell id)"], "make --eval"],
    [["make", "--eva", "$(shell id)"], "make --eval"],
    [["sed", "s/.*/id/e", "/dev/null"], "sed inline program"],
    [["gsed", "-e", "s/.*/id/e", "/dev/null"], "gsed -e"],
    [["sed", "-es/.*/id/e", "/dev/null"], "sed -e"],
  ] as const)("detects command carriers for %j", checkInlineEval);

  it("ignores normal script execution", () => {
    expectNoInlineEval(["node", "--evalish=console.log(1)"]);
    expectNoInlineEval(["python3", "-Wc", "print('hi')"]);
    expectNoInlineEval(["find", ".", "-execute", "id"]);
    expectNoInlineEval(["ruby", "-EUTF-8", "script.rb"]);
    expectNoInlineEval(["ruby", "-Itest", "script.rb"]);
    expectNoInlineEval(["ruby", "-W:deprecatede", "puts 1"]);
    expectNoInlineEval(["ruby", "-7pe", "puts 1"]);
    expectNoInlineEval(["perl", "-C0e", "say 1"]);
    expectNoInlineEval(["perl", "-0xFFpe", "say 1"]);
    expectNoInlineEval(["php", "-F", "filter.php"]);
    expectNoInlineEval(["Rscript", "script.R"]);
    expectNoInlineEval(["julia", "script.jl"]);
    expectNoInlineEval(["elixir", "-eIO.puts(1)"]);
    expectNoInlineEval(["iex", "-eIO.puts(1)"]);
    expectNoInlineEval(["guile", "-c(display 1)"]);
    expectNoInlineEval(["guile", "-e(display 1)"]);
    expectNoInlineEval(["groovy", "-encoding", "UTF-8", "script.groovy"]);
    expectNoInlineEval(["groovy", "-encoding=UTF-8", "script.groovy"]);
    expectNoInlineEval(["scala", "-encoding", "UTF-8", "script.scala"]);
    expectNoInlineEval(["clojure", "-M", "-m", "app.main"]);
    expectNoInlineEval(["clojure", "-e(println 1)"]);
    expectNoInlineEval(["raku", "script.raku"]);
    expectNoInlineEval(["ghc", "-exclude-module", "Debug.Trace"]);
    expectNoInlineEval(["erl", "-sname", "node"]);
    expectNoInlineEval(["gdb", "-e", "program"]);
    expectNoInlineEval(["gdb", "--command=commands.gdb"]);
    expectNoInlineEval(["gdb", "-eix", "early.gdb"]);
    expectNoInlineEval(["gdb", "-early-init-command", "early.gdb"]);
    expectNoInlineEval(["expect", "script.exp"]);
    expectNoInlineEval(["r2", "-e", "bin.cache=true", "program"]);
    expectNoInlineEval(["awk", "-f", "script.awk", "data.csv"]);
    expectNoInlineEval(["xargs", "-0"]);
    expectNoInlineEval(["make", "test"]);
    expectNoInlineEval(["make", "--e=$(info ok)"]);
    expectNoInlineEval(["sed", "-f", "script.sed", "input.txt"]);
    expectNoInlineEval(["sed", "-E", "-f", "script.sed", "input.txt"]);
  });

  it("matches interpreter-like allowlist patterns", () => {
    const patterns = `
      /usr/bin/python3 /usr/bin/python3.13 python3.* pypy3.10 **/node Rscript /opt/bin/julia
      **/elixir iex guile3.0 /usr/bin/groovy scala scala-cli clojure.exe
      **/clj raku perl6 ghci erl gdb expect
      /usr/bin/awk **/gawk /usr/bin/mawk nawk **/find xargs.exe /usr/bin/gmake **/gsed
    `
      .trim()
      .split(/\s+/u);
    for (const pattern of patterns) {
      expect(isInterpreterLikeAllowlistPattern(pattern)).toBe(true);
    }
    expect(isInterpreterLikeAllowlistPattern("r2")).toBe(false);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/rg")).toBe(false);
  });
});
