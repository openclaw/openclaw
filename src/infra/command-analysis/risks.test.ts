import { describe, expect, it } from "vitest";
import {
  buildCommandPayloadArgvCandidates,
  detectCarriedShellBuiltinArgv,
  detectCommandCarrierArgv,
  detectInlineEvalArgv,
  detectInlineEvalInSegments,
  detectShellWrapperThroughCarrierArgv,
} from "./risks.js";

const sudoFlags = ["-EH", "-i", "-s", "-k", "--reset-timestamp", "--shell"];

function expectInlineEval(argv: string[], flag = "-c") {
  expect(detectInlineEvalArgv(argv)?.flag).toBe(flag);
}

function expectNoInlineEval(argv: string[]) {
  expect(detectInlineEvalArgv(argv)).toBeNull();
}

function expectPayloads(argv: string[], expected: string[][]) {
  expect(buildCommandPayloadArgvCandidates(argv)).toEqual(expected);
}

function expectShellCarrier(argv: string[], expected: string | null) {
  expect(
    detectShellWrapperThroughCarrierArgv(argv, (args, startIndex) => args[startIndex] === "-lc"),
  ).toBe(expected);
}

describe("command-analysis risks", () => {
  it("detects inline eval through transparent carriers", () => {
    const find = ["find", ".", "-exec", "id", "{}", ";"];
    const trampoline = ["sh", "-lc", '$0 "$@"', "find", "."];
    expectInlineEval(["python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-u", "root", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-uroot", "python3", "-c", "print(1)"]);
    for (const flag of sudoFlags) {
      expectInlineEval(["sudo", flag, "python3", "-c", "print(1)"]);
    }
    expectInlineEval(["sudo", "--command-timeout=1", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "--chroot=/", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "PYTHONPATH=/tmp", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-u", "root", "PYTHONPATH=/tmp", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "--", "PYTHONPATH=/tmp", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-Eu", "root", "python3", "-c", "print(1)"]);
    expectInlineEval(["doas", "-uroot", "python3", "-c", "print(1)"]);
    expectInlineEval(["env", "sudo", "python3", "-c", "print(1)"]);
    expectInlineEval(["env", "env", "env", "env", "env", "env", "python3", "-c", "print(1)"]);
    expectInlineEval(["env", "-iSpython3 -c 'print(1)'"]);
    expectInlineEval(["env", "-iS", "python3 -c 'print(1)'"]);
    expectInlineEval(["env", "-S", "python3 -c", "print(1)"]);
    expectInlineEval(["env", "-iSpython3 -c", "print(1)"]);
    expectInlineEval(["env", "-P", "/usr/bin", "python3", "-c", "print(1)"]);
    expectInlineEval(["exec", "python3", "-c", "print(1)"]);
    expectInlineEval(["exec", "-a", "py", "python3", "-c", "print(1)"]);
    expectInlineEval(["command", "node", "--eval", "1"], "--eval");
    expectInlineEval(["env", "-S", 'python3 -c "print(1)"']);
    expectInlineEval(["sh", "-lc", '$0 "$@"', ...find], "-exec");
    expectInlineEval(["bash", "-c", 'exec -- "$0" "$@"', "xargs", "sh", "-c", "id"], "<command>");
    expectInlineEval(["env", ...trampoline, "-okdir", "id", "{}", ";"], "-okdir");
    expectInlineEval(["sudo", "sh", "-lc", '$0 "$@"', ...find], "-exec");
    expectInlineEval(["command", ...trampoline, "-execdir", "id", "{}", ";"], "-execdir");
    expectInlineEval(["sh", "-lc", '$0 "$1" "$2"', ...find], "-exec");
    expectNoInlineEval(["python3", "script.py"]);
  });

  it("keeps carrier inline eval detection command-boundary aware", () => {
    expectNoInlineEval(["command", "echo", "python3", "-c", "print(1)"]);
    expectNoInlineEval(["sudo", "echo", "python3", "-c", "print(1)"]);
    expectNoInlineEval(["sudo", "FOO=bar", "echo", "python3", "-c", "print(1)"]);
    expectNoInlineEval(["env", "-S", 'echo python3 -c "print(1)"']);
    expectNoInlineEval(["command", "-v", "python3", "-c", "print(1)"]);
    expectNoInlineEval(["sh", "-lc", '$0 "$@"', "find", ".", "-name", "*.ts"]);
    expectNoInlineEval(["sh", "-lc", 'echo "$0"; "$@"', "find", ".", "-exec"]);
    expectNoInlineEval(["sh", "-lc", '$0 "$1"', "find", ".", "-exec", "id", "{}", ";"]);
    expectNoInlineEval(["sh", "-lc", '$0 "$*"', "find", ".", "-exec", "id", "{}", ";"]);
  });

  it.each([
    { argv: ["find", ".", "-exec", "rm", "{}", ";"], command: "find", flag: "-exec" },
    { argv: ["xargs", "-I{}", "sh", "-c", "id"], command: "xargs" },
    { argv: ["runuser", "-u", "root", "python3", "-c", "print(1)"], command: "runuser" },
    { argv: ["env", "-S", "sh -c id"], command: "env", flag: "-S" },
    { argv: ["env", "-Ssh -c id"], command: "env", flag: "-S" },
    { argv: ["env", "-iS", "sh -c id"], command: "env", flag: "-S" },
    { argv: ["env", "-is", "sh -c id"], command: "env", flag: "-s" },
    { argv: ["env", "--split-string=sh -c id"], command: "env", flag: "--split-string" },
  ])("detects command carrier $argv", ({ argv, command, flag }) => {
    expect(detectCommandCarrierArgv(argv)).toEqual([flag ? { command, flag } : { command }]);
  });

  it("detects shell wrappers carried through prefix commands", () => {
    expectShellCarrier(["sudo", "bash", "-lc", "id"], "sudo");
    expectShellCarrier(["sudo", "-uroot", "bash", "-lc", "id"], "sudo");
    expectShellCarrier(["sudo", "-EH", "bash", "-lc", "id"], "sudo");
    expectShellCarrier(["exec", "bash", "-lc", "id"], "exec");
    expectShellCarrier(["sudo", "echo", "bash", "-lc", "id"], null);
  });

  it.each([
    { argv: ["builtin", "eval", "echo hi"], expected: { kind: "eval" } },
    { argv: ["command", "source", "./env.sh"], expected: { kind: "source", command: "source" } },
    { argv: ["exec", "eval", "echo hi"], expected: { kind: "eval" } },
    { argv: ["exec", "source", "./env.sh"], expected: { kind: "source", command: "source" } },
    { argv: ["command", "echo", "eval"], expected: null },
  ])("detects carried shell builtin $argv", ({ argv, expected }) => {
    expect(detectCarriedShellBuiltinArgv(argv)).toEqual(expected);
  });

  it("builds executable payload candidates through carriers and shell wrappers", () => {
    const allowOnce = [
      ["bash", "-lc", "/approve req allow-once"],
      ["/approve", "req", "allow-once"],
    ];
    const deny = [
      ["bash", "-lc", "/approve abc deny"],
      ["/approve", "abc", "deny"],
    ];
    expectPayloads(["FOO=1", "sudo", "-E", "/approve", "abc"], [["/approve", "abc"]]);
    for (const flag of sudoFlags) {
      expectPayloads(["sudo", flag, "/approve", "abc"], [["/approve", "abc"]]);
    }
    expectPayloads(["sudo", "--command-timeout=1", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "OPENCLAW_ENV=1", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "--preserve-groups", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "-uroot", "bash", "-lc", "/approve req allow-once"], allowOnce);
    expectPayloads(["doas", "-uroot", "bash", "-lc", "/approve req allow-once"], allowOnce);
    expectPayloads(["env", "-S", "bash -lc '/approve abc deny'"], deny);
    expectPayloads(["env", "-S", "bash -lc", "/approve abc deny"], deny);
    expectPayloads(["env", "-iSbash -lc", "/approve abc deny"], deny);
    expectPayloads(["env", "-P", "/usr/bin", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["exec", "-a", "openclaw", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["command", "-v", "/approve"], [["command", "-v", "/approve"]]);
    const command = ["openclaw", "channels", "login", "--channel", "whatsapp"];
    expectPayloads(
      ["env", "env", "env", "env", "env", "env", ...command],
      [5, 4, 3, 2, 1, 0].map((count) => Array<string>(count).fill("env").concat(command)),
    );
  });

  it("checks both effective and original argv for segment inline eval", () => {
    const argv = ["sudo", "python3", "-c", "print(1)"];
    const executable = {
      kind: "executable",
      rawExecutable: "sudo",
      executableName: "sudo",
    } as const;
    const hit = detectInlineEvalInSegments([
      {
        raw: "sudo python3 -c 'print(1)'",
        argv,
        resolution: {
          kind: "command",
          execution: executable,
          policy: executable,
          effectiveArgv: argv,
        },
      },
    ]);
    expect(hit?.normalizedExecutable).toBe("python3");
  });
});
