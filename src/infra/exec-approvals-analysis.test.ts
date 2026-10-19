import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateExecAllowlist } from "./exec-approvals-allowlist.js";
import {
  analyzeArgvCommand,
  buildEnforcedShellCommand,
  resolvePlannedSegmentArgv,
} from "./exec-approvals-analysis.js";
import {
  makeExecutable,
  makePathEnv,
  makeExecApprovalsTempDir,
} from "./exec-approvals-test-helpers.js";
import { analyzeWindowsShellCommand, windowsEscapeArg } from "./windows-shell-command.js";

const analyzeWindows = (command: string) =>
  analyzeWindowsShellCommand({ command, platform: "win32" });

function expectWindowsArgv(command: string, argv: string[]) {
  const result = analyzeWindows(command);
  expect(result.ok).toBe(true);
  expect(result.segments[0]?.argv).toEqual(argv);
}

describe("exec command analysis", () => {
  it("rejects empty argv commands", () => {
    const result = analyzeArgvCommand({ argv: ["", "   "] });
    expect(result).toEqual({ ok: false, reason: "empty argv", segments: [] });
  });

  it("keeps shell multiplexer rebuilds as coherent execution argv", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeExecApprovalsTempDir();
    const busybox = makeExecutable(dir, "busybox");

    const analysis = analyzeArgvCommand({
      argv: [busybox, "sh", "-lc", "echo hi"],
      cwd: dir,
      env: { PATH: `/bin:/usr/bin${path.delimiter}${process.env.PATH ?? ""}` },
    });

    expect(analysis.ok).toBe(true);
    const segment = analysis.segments[0];
    if (!segment) {
      throw new Error("expected first segment");
    }

    const planned = resolvePlannedSegmentArgv(segment);
    expect(planned).toEqual([
      segment.resolution?.execution.resolvedRealPath ?? segment.resolution?.execution.resolvedPath,
      "-lc",
      "echo hi",
    ]);
    expect(planned?.[0]).not.toBe(busybox);
  });

  it("accepts shell metacharacters inside double-quoted arguments", () => {
    for (const command of [
      'node add_lifelog.js "2026-03-28" "2026-03-28 (土) - LifeLog" --markdown',
      'node tool.js "--filter=a|b" "--label=x>y" "--name=foo & bar"',
      'node tool.js "--pattern=a^b"',
      'node tool.js "--msg=Hello!"',
    ]) {
      const res = analyzeWindows(command);
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv[0]).toBe("node");
    }
  });

  it.each([
    [
      "PowerShell expansions",
      [
        'node tool.js "--user=%USERNAME%"',
        'node app.js "$env:USERPROFILE"',
        "node app.js ${var}",
        "node app.js $(whoami)",
        'node app.js "$?"',
        'node app.js "$$"',
      ],
    ],
    [
      "cmd-incompatible single quotes",
      [
        "node tool.js '--name=foo & bar'",
        "node tool.js '--filter=a|b'",
        "node tool.js '--msg=Hello!'",
        "node tool.js '--pattern=(x)'",
        "node tool.js '--label=%USERNAME%'",
      ],
    ],
  ] satisfies Array<[string, string[]]>)("rejects %s", (_name, commands) => {
    for (const command of commands) {
      expect(analyzeWindows(command).ok).toBe(false);
    }
  });

  it("allows bare $ not followed by identifier", () => {
    expect(analyzeWindows('net use "\\\\host\\C$"').ok).toBe(true);
  });

  const toolPath = "C:\\Program Files\\Tool\\tool.exe";
  const workingDirectoryCommand =
    'powershell -WorkingDirectory "C:\\Users\\Jane Doe\\proj" -Command "node a.js"';
  it.each([
    ["node tool.js 'O''Brien'", ["node", "tool.js", "O'Brien"]],
    ['node tool.js ""', ["node", "tool.js", ""]],
    ["node tool.js ''", ["node", "tool.js", ""]],
    [`"${toolPath}" --version`, [toolPath, "--version"]],
    ['powershell -Command "node a.js ""hello world"""', ["node", "a.js", "hello world"]],
    ["powershell -Command 'node a.js ''hello world'''", ["node", "a.js", "hello world"]],
    [workingDirectoryCommand, ["node", "a.js"]],
    ['pwsh -NoLogo -c "node a.js"', ["node", "a.js"]],
    ["pwsh --command node a.js", ["node", "a.js"]],
  ] satisfies Array<[string, string[]]>)("parses Windows argv: %s", expectWindowsArgv);

  it("builds enforced command for simple Windows command", () => {
    // A fixture PATH keeps quoting independent of host Python installation paths.
    const dir = makeExecApprovalsTempDir();
    const python3 = makeExecutable(dir, "python3");
    const analysis = analyzeWindowsShellCommand({
      command: "python3 a.py",
      platform: "win32",
      env: makePathEnv(dir),
    });

    expect(analysis.ok).toBe(true);
    const result = buildEnforcedShellCommand({
      command: "python3 a.py",
      segments: analysis.segments,
      platform: "win32",
    });

    expect(result).toMatchObject({ ok: true, command: `& ${python3} a.py` });
  });

  it("rejects Windows commands with unsafe tokens", () => {
    const result = buildEnforcedShellCommand({
      command: "echo ok & del file",
      segments: [],
      platform: "win32",
    });

    expect(result.ok).toBe(false);
  });

  it.each([
    ["", '""'],
    ["hello world", '"hello world"'],
    ['say "hi"', '"say ""hi"""'],
  ])("escapes Windows argument %j", (value, escaped) => {
    expect(windowsEscapeArg(value)).toEqual({ ok: true, escaped });
  });

  it("rejects expansion tokens", () => {
    for (const value of ["%PATH%", "$env:SECRET", "$var", "${var}", "$(whoami)", "$?", "$$"]) {
      expect(windowsEscapeArg(value)).toEqual({ ok: false });
    }
  });

  it("evaluates inline cmd payloads against the inner executable", () => {
    const dir = makeExecApprovalsTempDir();
    const nodePath = path.join(dir, "node.exe");
    for (const file of [path.join(dir, "cmd.exe"), nodePath]) {
      fs.writeFileSync(file, "");
      fs.chmodSync(file, 0o755);
    }
    const env = makePathEnv(dir);
    const analysis = analyzeArgvCommand({
      argv: ["cmd.exe", "/c", "node.exe", "app.js"],
      cwd: dir,
      env,
    });

    expect(analysis.ok).toBe(true);
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [{ pattern: nodePath }],
      safeBins: new Set(),
      cwd: dir,
      env,
      platform: "win32",
    });
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual([nodePath]);
  });
});
