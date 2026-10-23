// Exercises recursive command-risk detection through interpreters, carriers,
// shell wrappers, env split-string, eval, and source invocations.
import { describe, expect, it } from "vitest";
import {
  buildCommandPayloadArgvCandidates,
  detectCarriedShellBuiltinArgv,
  detectCommandCarrierArgv,
  detectInlineEvalArgv,
  detectInlineEvalInSegments,
  detectShellWrapperThroughCarrierArgv,
} from "./risks.js";

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
    expectInlineEval(["python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-u", "root", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-uroot", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-EH", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-i", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-s", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-k", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "--reset-timestamp", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "--command-timeout=1", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "--chroot=/", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "PYTHONPATH=/tmp", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "-u", "root", "PYTHONPATH=/tmp", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "--", "PYTHONPATH=/tmp", "python3", "-c", "print(1)"]);
    expectInlineEval(["sudo", "--shell", "python3", "-c", "print(1)"]);
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
    expectInlineEval(["sh", "-lc", '$0 "$@"', "find", ".", "-exec", "id", "{}", ";"], "-exec");
    expectInlineEval(["bash", "-c", 'exec -- "$0" "$@"', "xargs", "sh", "-c", "id"], "<command>");
    expectInlineEval(
      ["env", "sh", "-lc", '$0 "$@"', "find", ".", "-okdir", "id", "{}", ";"],
      "-okdir",
    );
    expectInlineEval(
      ["sudo", "sh", "-lc", '$0 "$@"', "find", ".", "-exec", "id", "{}", ";"],
      "-exec",
    );
    expectInlineEval(
      ["command", "sh", "-lc", '$0 "$@"', "find", ".", "-execdir", "id", "{}", ";"],
      "-execdir",
    );
    expectInlineEval(["sh", "-lc", '$0 "$1" "$2"', "find", ".", "-exec", "id", "{}", ";"], "-exec");
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

  it("detects command carriers", () => {
    expect(detectCommandCarrierArgv(["find", ".", "-exec", "rm", "{}", ";"])).toEqual([
      { command: "find", flag: "-exec" },
    ]);
    expect(detectCommandCarrierArgv(["xargs", "-I{}", "sh", "-c", "id"])).toEqual([
      { command: "xargs" },
    ]);
    expect(detectCommandCarrierArgv(["env", "-S", "sh -c id"])).toEqual([
      { command: "env", flag: "-S" },
    ]);
    expect(
      detectCommandCarrierArgv(["runuser", "-u", "root", "python3", "-c", "print(1)"]),
    ).toEqual([{ command: "runuser" }]);
  });

  it.each([
    { args: ["-Ssh -c id"], flag: "-S" },
    { args: ["-iS", "sh -c id"], flag: "-S" },
    { args: ["-is", "sh -c id"], flag: "-s" },
    { args: ["--split-string=sh -c id"], flag: "--split-string" },
  ])("detects env split-string carrier form $args", ({ args, flag }) => {
    expect(detectCommandCarrierArgv(["env", ...args])).toEqual([{ command: "env", flag }]);
  });

  it("detects shell wrappers carried through prefix commands", () => {
    expectShellCarrier(["sudo", "bash", "-lc", "id"], "sudo");
    expectShellCarrier(["sudo", "-uroot", "bash", "-lc", "id"], "sudo");
    expectShellCarrier(["sudo", "-EH", "bash", "-lc", "id"], "sudo");
    expectShellCarrier(["exec", "bash", "-lc", "id"], "exec");
    expectShellCarrier(["sudo", "echo", "bash", "-lc", "id"], null);
  });

  it("detects carried eval and source builtins", () => {
    expect(detectCarriedShellBuiltinArgv(["builtin", "eval", "echo hi"])).toEqual({
      kind: "eval",
    });
    expect(detectCarriedShellBuiltinArgv(["command", "source", "./env.sh"])).toEqual({
      kind: "source",
      command: "source",
    });
    expect(detectCarriedShellBuiltinArgv(["exec", "eval", "echo hi"])).toEqual({
      kind: "eval",
    });
    expect(detectCarriedShellBuiltinArgv(["exec", "source", "./env.sh"])).toEqual({
      kind: "source",
      command: "source",
    });
    expect(detectCarriedShellBuiltinArgv(["command", "echo", "eval"])).toBeNull();
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
    expectPayloads(["sudo", "-EH", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "-i", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "-s", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "-k", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "--reset-timestamp", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "--command-timeout=1", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "OPENCLAW_ENV=1", "/approve", "abc"], [["/approve", "abc"]]);
    expectPayloads(["sudo", "--shell", "/approve", "abc"], [["/approve", "abc"]]);
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
    const hit = detectInlineEvalInSegments([
      {
        raw: "sudo python3 -c 'print(1)'",
        argv: ["sudo", "python3", "-c", "print(1)"],
        resolution: {
          kind: "command",
          execution: {
            kind: "executable",
            rawExecutable: "sudo",
            executableName: "sudo",
          },
          policy: {
            kind: "executable",
            rawExecutable: "sudo",
            executableName: "sudo",
          },
          effectiveArgv: ["sudo", "python3", "-c", "print(1)"],
        },
      },
    ]);
    expect(hit?.normalizedExecutable).toBe("python3");
  });
});
