// Covers argv analysis, Windows shell analysis, and allowlist matching primitives.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateExecAllowlist } from "./exec-approvals-allowlist.js";
import {
  analyzeArgvCommand,
  analyzeWindowsShellCommand,
  buildEnforcedShellCommand,
  resolvePlannedSegmentArgv,
  windowsEscapeArg,
} from "./exec-approvals-analysis.js";
import { makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import type { ExecAllowlistEntry } from "./exec-approvals.js";
import { matchAllowlist } from "./exec-command-resolution.js";

describe("exec argv analysis", () => {
  it("parses argv commands", () => {
    const res = analyzeArgvCommand({ argv: ["/bin/echo", "ok"] });

    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["/bin/echo", "ok"]);
  });

  it("rejects empty argv commands", () => {
    expect(analyzeArgvCommand({ argv: ["", "   "] })).toEqual({
      ok: false,
      reason: "empty argv",
      segments: [],
    });
  });

  it("keeps shell multiplexer rebuilds as coherent execution argv", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = path.join(dir, "busybox");
    fs.writeFileSync(busybox, "");
    fs.chmodSync(busybox, 0o755);

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
});

describe("Windows shell analysis", () => {
  it("accepts shell metacharacters inside double-quoted arguments", () => {
    const cases = [
      'node add_lifelog.js "2026-03-28" "2026-03-28 (土) - LifeLog" --markdown',
      'node tool.js "--filter=a|b" "--label=x>y" "--name=foo & bar"',
      'node tool.js "--pattern=a^b"',
      'node tool.js "--msg=Hello!"',
    ];

    for (const command of cases) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv[0]).toBe("node");
    }
  });

  it("rejects unquoted metacharacters", () => {
    const cases: string[] = [
      "ping 127.0.0.1 -n 1 & whoami",
      "node allowed.js; unlisted.exe",
      "echo hello | clip",
      "node tool.js > output.txt",
      "for /f %i in (file.txt) do echo %i",
    ];

    for (const command of cases) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects PowerShell expansion tokens", () => {
    const cases: string[] = [
      'node tool.js "--user=%USERNAME%"',
      'node app.js "$env:USERPROFILE"',
      "node app.js ${var}",
      "node app.js $(whoami)",
      'node app.js "$?"',
      'node app.js "$$"',
    ];

    for (const command of cases) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(false);
    }
  });

  it("allows bare $ not followed by identifier", () => {
    const res = analyzeWindowsShellCommand({
      command: 'net use "\\\\host\\C$"',
      platform: "win32",
    });

    expect(res.ok).toBe(true);
  });

  it("rejects metacharacters inside single-quoted arguments for cmd compatibility", () => {
    const unsafeSingleQuoteCommands: string[] = [
      "node tool.js '--name=foo & bar'",
      "node tool.js '--filter=a|b'",
      "node tool.js '--msg=Hello!'",
      "node tool.js '--pattern=(x)'",
      "node tool.js '--label=%USERNAME%'",
    ];

    for (const command of unsafeSingleQuoteCommands) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(false);
    }
  });

  it("tokenizes PowerShell single-quoted arguments", () => {
    const res = analyzeWindowsShellCommand({
      command: "node tool.js 'O''Brien'",
      platform: "win32",
    });

    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["node", "tool.js", "O'Brien"]);
  });

  it("preserves empty quoted args", () => {
    const doubleQuoted = analyzeWindowsShellCommand({
      command: 'node tool.js ""',
      platform: "win32",
    });
    const singleQuoted = analyzeWindowsShellCommand({
      command: "node tool.js ''",
      platform: "win32",
    });

    expect(doubleQuoted.ok).toBe(true);
    expect(doubleQuoted.segments[0]?.argv).toEqual(["node", "tool.js", ""]);
    expect(singleQuoted.ok).toBe(true);
    expect(singleQuoted.segments[0]?.argv).toEqual(["node", "tool.js", ""]);
  });

  it("parses quoted executables", () => {
    const res = analyzeWindowsShellCommand({
      command: '"C:\\Program Files\\Tool\\tool.exe" --version',
      platform: "win32",
    });

    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["C:\\Program Files\\Tool\\tool.exe", "--version"]);
  });

  it("unwraps PowerShell -Command payloads", () => {
    const powershellCommandCases: Array<readonly [string, string[]]> = [
      ['powershell -Command "node a.js ""hello world"""', ["node", "a.js", "hello world"]],
      ["powershell -Command 'node a.js ''hello world'''", ["node", "a.js", "hello world"]],
      [
        'powershell -WorkingDirectory "C:\\Users\\Jane Doe\\proj" -Command "node a.js"',
        ["node", "a.js"],
      ],
      ['pwsh -NoLogo -c "node a.js"', ["node", "a.js"]],
      ["pwsh --command node a.js", ["node", "a.js"]],
    ];

    for (const [command, argv] of powershellCommandCases) {
      const res = analyzeWindowsShellCommand({ command, platform: "win32" });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(argv);
    }
  });
});

describe("Windows enforced shell command rendering", () => {
  it("builds enforced command for simple Windows command", () => {
    const analysis = analyzeWindowsShellCommand({
      command: "python3 a.py",
      platform: "win32",
    });

    expect(analysis.ok).toBe(true);
    const result = buildEnforcedShellCommand({
      command: "python3 a.py",
      segments: analysis.segments,
      platform: "win32",
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe("& /usr/bin/python3 a.py");
  });

  it("rejects Windows commands with unsafe tokens", () => {
    const result = buildEnforcedShellCommand({
      command: "echo ok & del file",
      segments: [],
      platform: "win32",
    });

    expect(result.ok).toBe(false);
  });
});

describe("windowsEscapeArg", () => {
  it("quotes empty strings", () => {
    expect(windowsEscapeArg("")).toEqual({ ok: true, escaped: '""' });
  });

  it("returns safe values as-is", () => {
    expect(windowsEscapeArg("foo.exe")).toEqual({ ok: true, escaped: "foo.exe" });
    expect(windowsEscapeArg("C:/Program/bin")).toEqual({ ok: true, escaped: "C:/Program/bin" });
  });

  it("double-quotes values with spaces and escapes embedded quotes", () => {
    expect(windowsEscapeArg("hello world")).toEqual({ ok: true, escaped: '"hello world"' });
    expect(windowsEscapeArg('say "hi"')).toEqual({ ok: true, escaped: '"say ""hi"""' });
  });

  it("rejects expansion tokens", () => {
    expect(windowsEscapeArg("%PATH%")).toEqual({ ok: false });
    expect(windowsEscapeArg("$env:SECRET")).toEqual({ ok: false });
    expect(windowsEscapeArg("$var")).toEqual({ ok: false });
    expect(windowsEscapeArg("${var}")).toEqual({ ok: false });
    expect(windowsEscapeArg("$(whoami)")).toEqual({ ok: false });
    expect(windowsEscapeArg("$?")).toEqual({ ok: false });
    expect(windowsEscapeArg("$$")).toEqual({ ok: false });
  });

  it("allows $ not followed by identifier", () => {
    expect(windowsEscapeArg("\\\\host\\C$")).toEqual({ ok: true, escaped: '"\\\\host\\C$"' });
    expect(windowsEscapeArg("trailing$")).toEqual({ ok: true, escaped: '"trailing$"' });
  });
});

describe("matchAllowlist with argPattern", () => {
  const resolution = {
    rawExecutable: "python3",
    resolvedPath: "/usr/bin/python3",
    resolvedRealPath: "/usr/bin/python3",
    executableName: "python3",
  };

  it("matches path-only entry regardless of argv", () => {
    const entry = { pattern: "/usr/bin/python3" };
    const entries: ExecAllowlistEntry[] = [entry];

    expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3", "b.py"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3"])).toBe(entry);
  });

  it("matches argPattern with regex", () => {
    const entry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
    const entries: ExecAllowlistEntry[] = [entry];

    expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3", "b.py"])).toBeNull();
    expect(matchAllowlist(entries, resolution, ["python3", "a.py", "--verbose"])).toBeNull();
  });

  it.each(["linux", "darwin", "win32"])(
    "prefers argPattern match over path-only match on %s",
    (platform) => {
      const pathOnlyEntry = { pattern: "/usr/bin/python3" };
      const argPatternEntry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const entries: ExecAllowlistEntry[] = [pathOnlyEntry, argPatternEntry];

      const match = matchAllowlist(entries, resolution, ["python3", "a.py"], platform);

      expect(match).toBe(argPatternEntry);
    },
  );

  it.each(["linux", "darwin", "win32"])(
    "falls back to path-only match when argPattern does not match on %s",
    (platform) => {
      const pathOnlyEntry = { pattern: "/usr/bin/python3" };
      const argPatternEntry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const entries: ExecAllowlistEntry[] = [pathOnlyEntry, argPatternEntry];

      const match = matchAllowlist(entries, resolution, ["python3", "b.py"], platform);

      expect(match).toBe(pathOnlyEntry);
    },
  );

  it.each(["linux", "darwin", "win32"])(
    "requires argv before matching argPattern entries on %s",
    (platform) => {
      const restrictedEntries: ExecAllowlistEntry[] = [
        { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" },
      ];
      const mixedEntries: ExecAllowlistEntry[] = [
        { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" },
        { pattern: "/usr/bin/python3" },
      ];

      expect(matchAllowlist(restrictedEntries, resolution, undefined, platform)).toBeNull();
      expect(matchAllowlist(mixedEntries, resolution, undefined, platform)).toBe(mixedEntries[1]);
    },
  );

  it("handles invalid regex gracefully", () => {
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/python3", argPattern: "[invalid" }];

    expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBeNull();
  });

  it("rejects split-arg bypass against single-arg auto-generated argPattern", () => {
    const entry = { pattern: "/usr/bin/python3", argPattern: "^hello world\x00$" };
    const entries: ExecAllowlistEntry[] = [entry];

    expect(matchAllowlist(entries, resolution, ["python3", "hello world"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3", "hello", "world"])).toBeNull();
  });

  it("distinguishes zero-arg pattern from one-empty-string-arg pattern", () => {
    const zeroArgEntry = { pattern: "/usr/bin/python3", argPattern: "^\x00\x00$" };
    const emptyArgEntry = { pattern: "/usr/bin/python3", argPattern: "^\x00$" };

    expect(matchAllowlist([zeroArgEntry], resolution, ["python3"])).toBe(zeroArgEntry);
    expect(matchAllowlist([emptyArgEntry], resolution, ["python3"])).toBeNull();
    expect(matchAllowlist([emptyArgEntry], resolution, ["python3", ""])).toBe(emptyArgEntry);
    expect(matchAllowlist([zeroArgEntry], resolution, ["python3", ""])).toBeNull();
  });
});

describe("Windows inline allowlist analysis", () => {
  it("evaluates inline cmd payloads against the inner executable", () => {
    const dir = makeTempDir();
    const cmdPath = path.join(dir, "cmd.exe");
    const nodePath = path.join(dir, "node.exe");
    for (const file of [cmdPath, nodePath]) {
      fs.writeFileSync(file, "");
      fs.chmodSync(file, 0o755);
    }
    try {
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
