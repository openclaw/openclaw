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
    [["python3", "-c", "print('hi')"], "python3 -c"],
    [["python3", "-cprint('hi')"], "python3 -c"],
    [["python3", "-bc", "print('hi')"], "python3 -c"],
    [["python3", "-Sc", "print('hi')"], "python3 -c"],
    [["python3", "-xc", "print('hi')"], "python3 -c"],
    [["python3.13", "-c", "print('hi')"], "python3.13 -c"],
    [["/usr/bin/pypy3.10", "-c", "print('hi')"], "pypy3.10 -c"],
    [["/usr/bin/node", "--eval", "console.log('hi')"], "node --eval"],
    [["/usr/bin/node", "--eval=console.log('hi')"], "node --eval"],
    [["bun", "-pconsole.log('hi')"], "bun -p"],
    [["deno", "--print=1 + 1"], "deno --print"],
    [["ruby", "-eputs 1"], "ruby -e"],
    [["ruby", "-ane", "puts 1"], "ruby -e"],
    [["ruby", "-ce", "puts 1"], "ruby -e"],
    [["ruby", "-ne", "puts 1"], "ruby -e"],
    [["ruby", "-00pe", "puts 1"], "ruby -e"],
    [["ruby", "-p00e", "puts 1"], "ruby -e"],
    [["ruby", "-pe", "puts 1"], "ruby -e"],
    [["ruby", "-Se", "puts 1"], "ruby -e"],
    [["ruby", "-We", "puts 1"], "ruby -e"],
    [["ruby", "-W2e", "puts 1"], "ruby -e"],
    [["ruby", "-ve", "puts 1"], "ruby -e"],
    [["ruby", "-we", "puts 1"], "ruby -e"],
    [["perl", "-E", "say 1"], "perl -e"],
    [["perl", "-Esay 1"], "perl -e"],
    [["perl", "-ce", "say 1"], "perl -e"],
    [["perl", "-de", "say 1"], "perl -e"],
    [["perl", "-fe", "say 1"], "perl -e"],
    [["perl", "-l0e", "say 1"], "perl -e"],
    [["perl", "-ne", "say 1"], "perl -e"],
    [["perl", "-0777pe", "say 1"], "perl -e"],
    [["perl", "-p0777e", "say 1"], "perl -e"],
    [["perl", "-Se", "say 1"], "perl -e"],
    [["perl", "-Te", "say 1"], "perl -e"],
    [["perl", "-UE", "say 1"], "perl -e"],
    [["perl", "-Ve", "say 1"], "perl -e"],
    [["perl", "-We", "say 1"], "perl -e"],
    [["perl", "-we", "say 1"], "perl -e"],
    [["perl", "-Xe", "say 1"], "perl -e"],
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
    [["gdb", "-ev", "shell id"], "gdb -eval-command"],
    [["gdb", "-eval", "shell id"], "gdb -eval-command"],
    [["gdb", "-eval-c", "shell id"], "gdb -eval-command"],
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
    expect(detectInterpreterInlineEvalArgv(["julia", "script.jl"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["elixir", "script.exs"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["elixir", "-eIO.puts(1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["iex", "-eIO.puts(1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["guile", "script.scm"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["guile", "-c(display 1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["guile", "-e(display 1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["groovy", "script.groovy"])).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["groovy", "-encoding", "UTF-8", "script.groovy"]),
    ).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["groovy", "-encoding=UTF-8", "script.groovy"]),
    ).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["scala", "script.scala"])).toBeNull();
    expect(
      detectInterpreterInlineEvalArgv(["scala", "-encoding", "UTF-8", "script.scala"]),
    ).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["scala-cli", "script.scala"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["clojure", "-M", "-m", "app.main"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["clojure", "-e(println 1)"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["raku", "script.raku"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ghc", "Main.hs"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["ghc", "-exclude-module", "Debug.Trace"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["erl", "-sname", "node"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["erl", "-setcookie", "cookie"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["erl", "-shutdown_time", "1000"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["gdb", "-e", "program"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["gdb", "--command=commands.gdb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["gdb", "-eix", "early.gdb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["gdb", "-early-init-command", "early.gdb"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["expect", "script.exp"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["r2", "-e", "bin.cache=true", "program"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["awk", "-f", "script.awk", "data.csv"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["find", ".", "-name", "*.ts"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["xargs", "-0"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["make", "test"])).toBeNull();
    expect(detectInterpreterInlineEvalArgv(["make", "--e=$(info ok)"])).toBeNull();
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
    expect(isInterpreterLikeAllowlistPattern("/opt/bin/julia")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/elixir")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("iex")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("guile3.0")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("/usr/bin/groovy")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("scala")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("scala-cli")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("clojure.exe")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("**/clj")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("raku")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("perl6")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("ghci")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("erl")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("gdb")).toBe(true);
    expect(isInterpreterLikeAllowlistPattern("expect")).toBe(true);
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
