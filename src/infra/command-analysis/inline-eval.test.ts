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

function evalFlags(
  executable: string,
  flags: string,
  code: string,
  expected: string,
): [string[], string][] {
  return flags.split(" ").map((flag) => [[executable, flag, code], expected]);
}

function expectNoInlineEval(argv: string[]) {
  expect(detectInterpreterInlineEvalArgv(argv)).toBeNull();
}

describe("exec inline eval detection", () => {
  it.each([
    [["python3", "-c", "print('hi')"], "python3 -c"],
    [["python3", "-cprint('hi')"], "python3 -c"],
    ...evalFlags("python3", "-bc -Sc -xc", "print('hi')", "python3 -c"),
    [["python3.13", "-c", "print('hi')"], "python3.13 -c"],
    [["/usr/bin/pypy3.10", "-c", "print('hi')"], "pypy3.10 -c"],
    [["/usr/bin/node", "--eval", "console.log('hi')"], "node --eval"],
    [["/usr/bin/node", "--eval=console.log('hi')"], "node --eval"],
    [["bun", "-pconsole.log('hi')"], "bun -p"],
    [["deno", "--print=1 + 1"], "deno --print"],
    [["ruby", "-eputs 1"], "ruby -e"],
    ...evalFlags("ruby", "-ane -ce -ne -00pe -p00e -pe -Se -We -W2e -ve -we", "puts 1", "ruby -e"),
    [["perl", "-E", "say 1"], "perl -e"],
    [["perl", "-Esay 1"], "perl -e"],
    ...evalFlags(
      "perl",
      "-ce -de -fe -l0e -ne -0777pe -p0777e -Se -Te -UE -Ve -We -we -Xe",
      "say 1",
      "perl -e",
    ),
    [["php", "-B", "system('id');"], "php -B"],
    [["php", "-rsystem('id');"], "php -r"],
    [["php", "-E", "system('id');"], "php -E"],
    [["php", "-R", "system('id');"], "php -R"],
    [["Rscript", "-e", "system('id')"], "rscript -e"],
    [["julia", "-e", "run(`id`)"], "julia -e"],
    [["julia", "-erun(`id`)"], "julia -e"],
    [["julia", "--eval=run(`id`)"], "julia --eval"],
    [["julia", "-E", "VERSION"], "julia -E"],
    [["julia", "-EVERSION"], "julia -E"],
    [["elixir", "-e", 'System.cmd("id", [])'], "elixir -e"],
    [["elixir", '--eval=System.cmd("id", [])'], "elixir --eval"],
    [["elixir", "--rpc-eval", "worker@127.0.0.1", 'System.cmd("id", [])'], "elixir --rpc-eval"],
    [["iex", "-e", 'System.cmd("id", [])'], "iex -e"],
    [["iex", "--rpc-eval", "worker@127.0.0.1", 'System.cmd("id", [])'], "iex --rpc-eval"],
    [["guile", "-c", '(system "id")'], "guile -c"],
    [["guile", "-e", '(lambda args (system "id"))', "/dev/null"], "guile -e"],
    [["groovy", "-e", '"id".execute()'], "groovy -e"],
    [["groovy", '-e"id".execute()'], "groovy -e"],
    [["groovy", "-ne", '["id"].execute()'], "groovy -e"],
    [["groovy", "-pe", '["id"].execute()'], "groovy -e"],
    [["groovy", '-encoding:["id"].execute()'], "groovy -e"],
    [["scala", "-e", 'sys.process.Process("id").!'], "scala -e"],
    [["scala", "--script-snippet", 'sys.process.Process("id").!'], "scala --script-snippet"],
    [
      ["scala-cli", "--script-snippet", 'sys.process.Process("id").!'],
      "scala-cli --script-snippet",
    ],
    [["scala", "--execute-script", 'sys.process.Process("id").!'], "scala --execute-script"],
    [["scala", "--execute-sc=println(1)"], "scala --execute-sc"],
    [["scala", "--execute-scala-script=println(1)"], "scala --execute-scala-script"],
    [["scala", "--scala-snippet=println(1)"], "scala --scala-snippet"],
    [["scala", "--execute-scala=println(1)"], "scala --execute-scala"],
    [["scala", "--java-snippet", "class Main {}"], "scala --java-snippet"],
    [["scala", "--execute-java=class Main {}"], "scala --execute-java"],
    [["scala", "--markdown-snippet", "```scala\nprintln(1)\n```"], "scala --markdown-snippet"],
    [["scala", "--md-snippet=```scala\nprintln(1)\n```"], "scala --md-snippet"],
    [["scala", "--execute-markdown", "```scala\nprintln(1)\n```"], "scala --execute-markdown"],
    [["scala", "--execute-md=```scala\nprintln(1)\n```"], "scala --execute-md"],
    [["clojure", "-e", '(clojure.java.shell/sh "id")'], "clojure -e"],
    [["clj", "--eval", "(println 1)"], "clj --eval"],
    [["raku", "-e", "run 'id'"], "raku -e"],
    [["raku", "-e say 1"], "raku -e"],
    [["raku", "-ne", "run 'id'"], "raku -e"],
    [["perl6", "-e", "run 'id'"], "perl6 -e"],
    [["perl6", "-pe", "run 'id'"], "perl6 -e"],
    [["ghc", "-e", 'System.Process.system "id"'], "ghc -e"],
    [["ghci", "-e", 'System.Process.system "id"'], "ghci -e"],
    [["erl", "-eval", 'os:cmd("id").'], "erl -eval"],
    [["erl", "-run", "os", "cmd", "id"], "erl -run"],
    [["erl", "-s", "os", "cmd", "id"], "erl -s"],
    [["erl", "-noshell", "-s", "init", "stop"], "erl -s"],
    [["werl", "-eval", 'os:cmd("id").'], "werl -eval"],
    [["werl", "-run", "os", "cmd", "id"], "werl -run"],
    [["gdb", "-ex", "shell id", "-ex", "quit"], "gdb -ex"],
    [["gdb", "-ex=shell id", "-ex", "quit"], "gdb -ex"],
    [["gdb", "-iex", "shell id"], "gdb -iex"],
    [["gdb", "-iex=shell id"], "gdb -iex"],
    ...evalFlags("gdb", "-ev -eval -eval-c", "shell id", "gdb -eval-command"),
    [["gdb", "-eval-c=shell id"], "gdb -eval-command"],
    [["gdb", "-eval-command", "shell id"], "gdb -eval-command"],
    [["gdb", "-eval-command=shell id"], "gdb -eval-command"],
    [["gdb", "--ev", "shell id"], "gdb --eval-command"],
    [["gdb", "--eval", "shell id"], "gdb --eval-command"],
    [["gdb", "--eval-c=shell id"], "gdb --eval-command"],
    [["gdb", "--eval-command=shell id"], "gdb --eval-command"],
    [["gdb", "-init-e", "shell id"], "gdb -init-eval-command"],
    [["gdb", "-init-eval", "shell id"], "gdb -init-eval-command"],
    [["gdb", "-init-eval-c=shell id"], "gdb -init-eval-command"],
    [["gdb", "--init-e", "shell id"], "gdb --init-eval-command"],
    [["gdb", "--init-eval-command=shell id"], "gdb --init-eval-command"],
    [["gdb", "--init-eval=shell id"], "gdb --init-eval-command"],
    [["gdb", "-init-eval-command=shell id"], "gdb -init-eval-command"],
    [["gdb", "-eiex", "shell id"], "gdb -eiex"],
    [["gdb", "-eiex=shell id"], "gdb -eiex"],
    [["gdb", "-early-init-e", "shell id"], "gdb -early-init-eval-command"],
    [["gdb", "-early-init-eval", "shell id"], "gdb -early-init-eval-command"],
    [["gdb", "--early-init-e=shell id"], "gdb --early-init-eval-command"],
    [["gdb", "--early-init-eval=shell id"], "gdb --early-init-eval-command"],
    [["gdb", "-early-init-eval-command=shell id"], "gdb -early-init-eval-command"],
    [["expect", "-c", "spawn id"], "expect -c"],
    [["expect", "-cspawn id"], "expect -c"],
    [["lua", "-eprint(1)"], "lua -e"],
    [["osascript", "-e", "beep"], "osascript -e"],
    [["osascript", '-edisplay alert "hi"'], "osascript -e"],
    [["awk", "BEGIN { print 1 }"], "awk inline program"],
    [["gawk", "-F", ",", "{print $1}", "data.csv"], "gawk inline program"],
  ] as const)("detects interpreter eval flags for %j", (argv, expected) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expectInlineEvalDescription(hit, expected);
  });

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
  ] as const)("detects command carriers for %j", (argv, expected) => {
    const hit = detectInterpreterInlineEvalArgv([...argv]);
    expectInlineEvalDescription(hit, expected);
  });

  it("ignores normal script execution", () => {
    expectNoInlineEval(["python3", "script.py"]);
    expectNoInlineEval(["python3.13", "script.py"]);
    expectNoInlineEval(["node", "script.js"]);
    expectNoInlineEval(["node", "--evalish=console.log(1)"]);
    expectNoInlineEval(["python3", "-Wc", "print('hi')"]);
    expectNoInlineEval(["python3", "-Xc", "print('hi')"]);
    expectNoInlineEval(["find", ".", "-execute", "id"]);
    expectNoInlineEval(["ruby", "-EUTF-8", "script.rb"]);
    expectNoInlineEval(["ruby", "-Itest", "script.rb"]);
    expectNoInlineEval(["ruby", "-W:deprecatede", "puts 1"]);
    expectNoInlineEval(["ruby", "-7pe", "puts 1"]);
    expectNoInlineEval(["perl", "-C0e", "say 1"]);
    expectNoInlineEval(["perl", "-D0e", "say 1"]);
    expectNoInlineEval(["perl", "-me", "say 1"]);
    expectNoInlineEval(["perl", "-Me", "say 1"]);
    expectNoInlineEval(["perl", "-7pe", "say 1"]);
    expectNoInlineEval(["perl", "-0xFFpe", "say 1"]);
    expectNoInlineEval(["php", "-F", "filter.php"]);
    expectNoInlineEval(["Rscript", "script.R"]);
    expectNoInlineEval(["julia", "script.jl"]);
    expectNoInlineEval(["elixir", "script.exs"]);
    expectNoInlineEval(["elixir", "-eIO.puts(1)"]);
    expectNoInlineEval(["iex", "-eIO.puts(1)"]);
    expectNoInlineEval(["guile", "script.scm"]);
    expectNoInlineEval(["guile", "-c(display 1)"]);
    expectNoInlineEval(["guile", "-e(display 1)"]);
    expectNoInlineEval(["groovy", "script.groovy"]);
    expectNoInlineEval(["groovy", "-encoding", "UTF-8", "script.groovy"]);
    expectNoInlineEval(["groovy", "-encoding=UTF-8", "script.groovy"]);
    expectNoInlineEval(["scala", "script.scala"]);
    expectNoInlineEval(["scala", "-encoding", "UTF-8", "script.scala"]);
    expectNoInlineEval(["scala-cli", "script.scala"]);
    expectNoInlineEval(["clojure", "-M", "-m", "app.main"]);
    expectNoInlineEval(["clojure", "-e(println 1)"]);
    expectNoInlineEval(["raku", "script.raku"]);
    expectNoInlineEval(["ghc", "Main.hs"]);
    expectNoInlineEval(["ghc", "-exclude-module", "Debug.Trace"]);
    expectNoInlineEval(["erl", "-sname", "node"]);
    expectNoInlineEval(["erl", "-setcookie", "cookie"]);
    expectNoInlineEval(["erl", "-shutdown_time", "1000"]);
    expectNoInlineEval(["gdb", "-e", "program"]);
    expectNoInlineEval(["gdb", "--command=commands.gdb"]);
    expectNoInlineEval(["gdb", "-eix", "early.gdb"]);
    expectNoInlineEval(["gdb", "-early-init-command", "early.gdb"]);
    expectNoInlineEval(["expect", "script.exp"]);
    expectNoInlineEval(["r2", "-e", "bin.cache=true", "program"]);
    expectNoInlineEval(["awk", "-f", "script.awk", "data.csv"]);
    expectNoInlineEval(["find", ".", "-name", "*.ts"]);
    expectNoInlineEval(["xargs", "-0"]);
    expectNoInlineEval(["make", "test"]);
    expectNoInlineEval(["make", "--e=$(info ok)"]);
    expectNoInlineEval(["sed", "-f", "script.sed", "input.txt"]);
    expectNoInlineEval(["sed", "-i", "-f", "script.sed", "input.txt"]);
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
