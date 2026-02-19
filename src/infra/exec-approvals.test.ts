import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeArgvCommand,
  analyzeShellCommand,
  buildSafeBinsShellCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  isSafeBinUsage,
  matchAllowlist,
  maxAsk,
  mergeExecApprovalsSocketDefaults,
  minSecurity,
  normalizeExecApprovals,
  normalizeSafeBins,
  requiresExecApproval,
  resolveCommandResolution,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
  type ExecAllowlistEntry,
  type ExecApprovalsFile,
} from "./exec-approvals.js";

function makePathEnv(binDir: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return { PATH: binDir };
  }
  return { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT;.COM" };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
}

describe("exec approvals allowlist matching", () => {
  it("ignores basename-only patterns", () => {
    const resolution = {
      rawExecutable: "rg",
      resolvedPath: "/opt/homebrew/bin/rg",
      executableName: "rg",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "RG" }];
    const match = matchAllowlist(entries, resolution);
    expect(match).toBeNull();
  });

  it("matches by resolved path with **", () => {
    const resolution = {
      rawExecutable: "rg",
      resolvedPath: "/opt/homebrew/bin/rg",
      executableName: "rg",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "/opt/**/rg" }];
    const match = matchAllowlist(entries, resolution);
    expect(match?.pattern).toBe("/opt/**/rg");
  });

  it("does not let * cross path separators", () => {
    const resolution = {
      rawExecutable: "rg",
      resolvedPath: "/opt/homebrew/bin/rg",
      executableName: "rg",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "/opt/*/rg" }];
    const match = matchAllowlist(entries, resolution);
    expect(match).toBeNull();
  });

  it("requires a resolved path", () => {
    const resolution = {
      rawExecutable: "bin/rg",
      resolvedPath: undefined,
      executableName: "rg",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "bin/rg" }];
    const match = matchAllowlist(entries, resolution);
    expect(match).toBeNull();
  });
});

describe("mergeExecApprovalsSocketDefaults", () => {
  it("prefers normalized socket, then current, then default path", () => {
    const normalized = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/a.sock", token: "a" },
    });
    const current = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/b.sock", token: "b" },
    });
    const merged = mergeExecApprovalsSocketDefaults({ normalized, current });
    expect(merged.socket?.path).toBe("/tmp/a.sock");
    expect(merged.socket?.token).toBe("a");
  });

  it("falls back to current token when missing in normalized", () => {
    const normalized = normalizeExecApprovals({ version: 1, agents: {} });
    const current = normalizeExecApprovals({
      version: 1,
      agents: {},
      socket: { path: "/tmp/b.sock", token: "b" },
    });
    const merged = mergeExecApprovalsSocketDefaults({ normalized, current });
    expect(merged.socket?.path).toBeTruthy();
    expect(merged.socket?.token).toBe("b");
  });
});

describe("resolve exec approvals defaults", () => {
  it("expands home-prefixed default file and socket paths", () => {
    const dir = makeTempDir();
    const prevOpenClawHome = process.env.OPENCLAW_HOME;
    try {
      process.env.OPENCLAW_HOME = dir;
      expect(path.normalize(resolveExecApprovalsPath())).toBe(
        path.normalize(path.join(dir, ".openclaw", "exec-approvals.json")),
      );
      expect(path.normalize(resolveExecApprovalsSocketPath())).toBe(
        path.normalize(path.join(dir, ".openclaw", "exec-approvals.sock")),
      );
    } finally {
      if (prevOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = prevOpenClawHome;
      }
    }
  });
});

describe("exec approvals safe shell command builder", () => {
  it("quotes only safeBins segments (leaves other segments untouched)", () => {
    if (process.platform === "win32") {
      return;
    }

    const analysis = analyzeShellCommand({
      command: "rg foo src/*.ts | head -n 5 && echo ok",
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin" },
      platform: process.platform,
    });
    expect(analysis.ok).toBe(true);

    const res = buildSafeBinsShellCommand({
      command: "rg foo src/*.ts | head -n 5 && echo ok",
      segments: analysis.segments,
      segmentSatisfiedBy: [null, "safeBins", null],
      platform: process.platform,
    });
    expect(res.ok).toBe(true);
    // Preserve non-safeBins segment raw (glob stays unquoted)
    expect(res.command).toContain("rg foo src/*.ts");
    // SafeBins segment is fully quoted
    expect(res.command).toContain("'head' '-n' '5'");
  });
});

describe("exec approvals command resolution", () => {
  it("resolves PATH executables", () => {
    const dir = makeTempDir();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exeName = process.platform === "win32" ? "rg.exe" : "rg";
    const exe = path.join(binDir, exeName);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    const res = resolveCommandResolution("rg -n foo", undefined, makePathEnv(binDir));
    expect(res?.resolvedPath).toBe(exe);
    expect(res?.executableName).toBe(exeName);
  });

  it("resolves relative paths against cwd", () => {
    const dir = makeTempDir();
    const cwd = path.join(dir, "project");
    const script = path.join(cwd, "scripts", "run.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    fs.chmodSync(script, 0o755);
    const res = resolveCommandResolution("./scripts/run.sh --flag", cwd, undefined);
    expect(res?.resolvedPath).toBe(script);
  });

  it("parses quoted executables", () => {
    const dir = makeTempDir();
    const cwd = path.join(dir, "project");
    const script = path.join(cwd, "bin", "tool");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    fs.chmodSync(script, 0o755);
    const res = resolveCommandResolution('"./bin/tool" --version', cwd, undefined);
    expect(res?.resolvedPath).toBe(script);
  });
});

describe("exec approvals shell parsing", () => {
  it("parses simple pipelines", () => {
    const res = analyzeShellCommand({ command: "echo ok | jq .foo" });
    expect(res.ok).toBe(true);
    expect(res.segments.map((seg) => seg.argv[0])).toEqual(["echo", "jq"]);
  });

  it("parses chained commands", () => {
    const res = analyzeShellCommand({ command: "ls && rm -rf /" });
    expect(res.ok).toBe(true);
    expect(res.chains?.map((chain) => chain[0]?.argv[0])).toEqual(["ls", "rm"]);
  });

  it("parses argv commands", () => {
    const res = analyzeArgvCommand({ argv: ["/bin/echo", "ok"] });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["/bin/echo", "ok"]);
  });

  it("rejects command substitution inside double quotes", () => {
    const res = analyzeShellCommand({ command: 'echo "output: $(whoami)"' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported shell token: $()");
  });

  it("rejects backticks inside double quotes", () => {
    const res = analyzeShellCommand({ command: 'echo "output: `id`"' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported shell token: `");
  });

  it("rejects command substitution outside quotes", () => {
    const res = analyzeShellCommand({ command: "echo $(whoami)" });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported shell token: $()");
  });

  it("allows escaped command substitution inside double quotes", () => {
    const res = analyzeShellCommand({ command: 'echo "output: \\$(whoami)"' });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv[0]).toBe("echo");
  });

  it("allows command substitution syntax inside single quotes", () => {
    const res = analyzeShellCommand({ command: "echo 'output: $(whoami)'" });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv[0]).toBe("echo");
  });

  it("rejects input redirection (<)", () => {
    const res = analyzeShellCommand({ command: "cat < input.txt" });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported shell token: <");
  });

  it("rejects output redirection (>)", () => {
    const res = analyzeShellCommand({ command: "echo ok > output.txt" });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported shell token: >");
  });

  it("allows heredoc operator (<<)", () => {
    const res = analyzeShellCommand({ command: "/usr/bin/tee /tmp/file << 'EOF'" });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv[0]).toBe("/usr/bin/tee");
  });

  it("allows heredoc without space before delimiter", () => {
    const res = analyzeShellCommand({ command: "/usr/bin/tee /tmp/file <<EOF" });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv[0]).toBe("/usr/bin/tee");
  });

  it("allows heredoc with strip-tabs operator (<<-)", () => {
    const res = analyzeShellCommand({ command: "/usr/bin/cat <<-DELIM" });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv[0]).toBe("/usr/bin/cat");
  });

  it("allows heredoc in pipeline", () => {
    const res = analyzeShellCommand({ command: "/usr/bin/cat << 'EOF' | /usr/bin/grep pattern" });
    expect(res.ok).toBe(true);
    expect(res.segments).toHaveLength(2);
    expect(res.segments[0]?.argv[0]).toBe("/usr/bin/cat");
    expect(res.segments[1]?.argv[0]).toBe("/usr/bin/grep");
  });

  it("allows multiline heredoc body", () => {
    const res = analyzeShellCommand({
      command: "/usr/bin/tee /tmp/file << 'EOF'\nline one\nline two\nEOF",
    });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv[0]).toBe("/usr/bin/tee");
  });

  it("allows multiline heredoc body with strip-tabs operator (<<-)", () => {
    const res = analyzeShellCommand({
      command: "/usr/bin/cat <<-EOF\n\tline one\n\tline two\n\tEOF",
    });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv[0]).toBe("/usr/bin/cat");
  });

  it("rejects multiline commands without heredoc", () => {
    const res = analyzeShellCommand({
      command: "/usr/bin/echo first line\n/usr/bin/echo second line",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported shell token: \n");
  });

  it("rejects windows shell metacharacters", () => {
    const res = analyzeShellCommand({
      command: "ping 127.0.0.1 -n 1 & whoami",
      platform: "win32",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported windows shell token: &");
  });

  it("parses windows quoted executables", () => {
    const res = analyzeShellCommand({
      command: '"C:\\Program Files\\Tool\\tool.exe" --version',
      platform: "win32",
    });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["C:\\Program Files\\Tool\\tool.exe", "--version"]);
  });
});

describe("exec approvals shell allowlist (chained commands)", () => {
  it("allows chained commands when all parts are allowlisted", () => {
    const allowlist: ExecAllowlistEntry[] = [
      { pattern: "/usr/bin/obsidian-cli" },
      { pattern: "/usr/bin/head" },
    ];
    const result = evaluateShellAllowlist({
      command:
        "/usr/bin/obsidian-cli print-default && /usr/bin/obsidian-cli search foo | /usr/bin/head",
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("rejects chained commands when any part is not allowlisted", () => {
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/obsidian-cli" }];
    const result = evaluateShellAllowlist({
      command: "/usr/bin/obsidian-cli print-default && /usr/bin/rm -rf /",
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("returns analysisOk=false for malformed chains", () => {
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/echo" }];
    const result = evaluateShellAllowlist({
      command: "/usr/bin/echo ok &&",
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(false);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("respects quotes when splitting chains", () => {
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/echo" }];
    const result = evaluateShellAllowlist({
      command: '/usr/bin/echo "foo && bar"',
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("respects escaped quotes when splitting chains", () => {
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/echo" }];
    const result = evaluateShellAllowlist({
      command: '/usr/bin/echo "foo\\" && bar"',
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("rejects windows chain separators for allowlist analysis", () => {
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/ping" }];
    const result = evaluateShellAllowlist({
      command: "ping 127.0.0.1 -n 1 & whoami",
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
      platform: "win32",
    });
    expect(result.analysisOk).toBe(false);
    expect(result.allowlistSatisfied).toBe(false);
  });
});

describe("exec approvals safe bins", () => {
  type SafeBinCase = {
    name: string;
    argv: string[];
    resolvedPath: string;
    expected: boolean;
    cwd?: string;
    setup?: (cwd: string) => void;
  };

  const cases: SafeBinCase[] = [
    {
      name: "allows safe bins with non-path args",
      argv: ["jq", ".foo"],
      resolvedPath: "/usr/bin/jq",
      expected: true,
    },
    {
      name: "blocks safe bins with file args",
      argv: ["jq", ".foo", "secret.json"],
      resolvedPath: "/usr/bin/jq",
      expected: false,
      setup: (cwd) => fs.writeFileSync(path.join(cwd, "secret.json"), "{}"),
    },
    {
      name: "blocks safe bins resolved from untrusted directories",
      argv: ["jq", ".foo"],
      resolvedPath: "/tmp/evil-bin/jq",
      expected: false,
      cwd: "/tmp",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      if (process.platform === "win32") {
        return;
      }
      const cwd = testCase.cwd ?? makeTempDir();
      testCase.setup?.(cwd);
      const ok = isSafeBinUsage({
        argv: testCase.argv,
        resolution: {
          rawExecutable: "jq",
          resolvedPath: testCase.resolvedPath,
          executableName: "jq",
        },
        safeBins: normalizeSafeBins(["jq"]),
        cwd,
      });
      expect(ok).toBe(testCase.expected);
    });
  }

  it("supports injected trusted safe-bin dirs for tests/callers", () => {
    if (process.platform === "win32") {
      return;
    }
    const ok = isSafeBinUsage({
      argv: ["jq", ".foo"],
      resolution: {
        rawExecutable: "jq",
        resolvedPath: "/custom/bin/jq",
        executableName: "jq",
      },
      safeBins: normalizeSafeBins(["jq"]),
      trustedSafeBinDirs: new Set(["/custom/bin"]),
      cwd: "/tmp",
    });
    expect(ok).toBe(true);
  });
});

describe("exec approvals allowlist evaluation", () => {
  it("satisfies allowlist on exact match", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "tool",
          argv: ["tool"],
          resolution: {
            rawExecutable: "tool",
            resolvedPath: "/usr/bin/tool",
            executableName: "tool",
          },
        },
      ],
    };
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/tool" }];
    const result = evaluateExecAllowlist({
      analysis,
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
  });

  it("satisfies allowlist via safe bins", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "jq .foo",
          argv: ["jq", ".foo"],
          resolution: {
            rawExecutable: "jq",
            resolvedPath: "/usr/bin/jq",
            executableName: "jq",
          },
        },
      ],
    };
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["jq"]),
      cwd: "/tmp",
    });
    // Safe bins are disabled on Windows (PowerShell parsing/expansion differences).
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches).toEqual([]);
  });

  it("satisfies allowlist via auto-allow skills", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "skill-bin",
          argv: ["skill-bin", "--help"],
          resolution: {
            rawExecutable: "skill-bin",
            resolvedPath: "/opt/skills/skill-bin",
            executableName: "skill-bin",
          },
        },
      ],
    };
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: new Set(),
      skillBins: new Set(["skill-bin"]),
      autoAllowSkills: true,
      cwd: "/tmp",
    });
    expect(result.allowlistSatisfied).toBe(true);
  });
});

describe("exec approvals policy helpers", () => {
  it("minSecurity returns the more restrictive value", () => {
    expect(minSecurity("deny", "full")).toBe("deny");
    expect(minSecurity("allowlist", "full")).toBe("allowlist");
  });

  it("maxAsk returns the more aggressive ask mode", () => {
    expect(maxAsk("off", "always")).toBe("always");
    expect(maxAsk("on-miss", "off")).toBe("on-miss");
  });

  it("requiresExecApproval respects ask mode and allowlist satisfaction", () => {
    expect(
      requiresExecApproval({
        ask: "always",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: true,
      }),
    ).toBe(true);
    expect(
      requiresExecApproval({
        ask: "off",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: false,
      }),
    ).toBe(false);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: true,
      }),
    ).toBe(false);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: false,
        allowlistSatisfied: false,
      }),
    ).toBe(true);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "full",
        analysisOk: false,
        allowlistSatisfied: false,
      }),
    ).toBe(false);
  });
});

describe("exec approvals wildcard agent", () => {
  it("merges wildcard allowlist entries with agent entries", () => {
    const dir = makeTempDir();
    const prevOpenClawHome = process.env.OPENCLAW_HOME;

    try {
      process.env.OPENCLAW_HOME = dir;
      const approvalsPath = path.join(dir, ".openclaw", "exec-approvals.json");
      fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
      fs.writeFileSync(
        approvalsPath,
        JSON.stringify(
          {
            version: 1,
            agents: {
              "*": { allowlist: [{ pattern: "/bin/hostname" }] },
              main: { allowlist: [{ pattern: "/usr/bin/uname" }] },
            },
          },
          null,
          2,
        ),
      );

      const resolved = resolveExecApprovals("main");
      expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual([
        "/bin/hostname",
        "/usr/bin/uname",
      ]);
    } finally {
      if (prevOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = prevOpenClawHome;
      }
    }
  });
});

describe("exec approvals node host allowlist check", () => {
  // These tests verify the allowlist satisfaction logic used by the node host path
  // The node host checks: matchAllowlist() || isSafeBinUsage() for each command segment
  // Using hardcoded resolution objects for cross-platform compatibility

  it("satisfies allowlist when command matches exact path pattern", () => {
    const resolution = {
      rawExecutable: "python3",
      resolvedPath: "/usr/bin/python3",
      executableName: "python3",
    };
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/python3" }];
    const match = matchAllowlist(entries, resolution);
    expect(match).not.toBeNull();
    expect(match?.pattern).toBe("/usr/bin/python3");
  });

  it("satisfies allowlist when command matches ** wildcard pattern", () => {
    // Simulates symlink resolution: /opt/homebrew/bin/python3 -> /opt/homebrew/opt/python@3.14/bin/python3.14
    const resolution = {
      rawExecutable: "python3",
      resolvedPath: "/opt/homebrew/opt/python@3.14/bin/python3.14",
      executableName: "python3.14",
    };
    // Pattern with ** matches across multiple directories
    const entries: ExecAllowlistEntry[] = [{ pattern: "/opt/**/python*" }];
    const match = matchAllowlist(entries, resolution);
    expect(match?.pattern).toBe("/opt/**/python*");
  });

  it("does not satisfy allowlist when command is not in allowlist", () => {
    const resolution = {
      rawExecutable: "unknown-tool",
      resolvedPath: "/usr/local/bin/unknown-tool",
      executableName: "unknown-tool",
    };
    // Allowlist has different commands
    const entries: ExecAllowlistEntry[] = [
      { pattern: "/usr/bin/python3" },
      { pattern: "/opt/**/node" },
    ];
    const match = matchAllowlist(entries, resolution);
    expect(match).toBeNull();

    // Also not a safe bin
    const safe = isSafeBinUsage({
      argv: ["unknown-tool", "--help"],
      resolution,
      safeBins: normalizeSafeBins(["jq", "curl"]),
      cwd: "/tmp",
    });
    expect(safe).toBe(false);
  });

  it("satisfies via safeBins even when not in allowlist", () => {
    const resolution = {
      rawExecutable: "jq",
      resolvedPath: "/usr/bin/jq",
      executableName: "jq",
    };
    // Not in allowlist
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/python3" }];
    const match = matchAllowlist(entries, resolution);
    expect(match).toBeNull();

    // But is a safe bin with non-file args
    const safe = isSafeBinUsage({
      argv: ["jq", ".foo"],
      resolution,
      safeBins: normalizeSafeBins(["jq"]),
      cwd: "/tmp",
    });
    // Safe bins are disabled on Windows (PowerShell parsing/expansion differences).
    if (process.platform === "win32") {
      expect(safe).toBe(false);
      return;
    }
    expect(safe).toBe(true);
  });
});

describe("exec approvals default agent migration", () => {
  it("migrates legacy default agent entries to main", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        default: { allowlist: [{ pattern: "/bin/legacy" }] },
      },
    };
    const resolved = resolveExecApprovalsFromFile({ file });
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(["/bin/legacy"]);
    expect(resolved.file.agents?.default).toBeUndefined();
    expect(resolved.file.agents?.main?.allowlist?.[0]?.pattern).toBe("/bin/legacy");
  });

  it("prefers main agent settings when both main and default exist", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: { ask: "always", allowlist: [{ pattern: "/bin/main" }] },
        default: { ask: "off", allowlist: [{ pattern: "/bin/legacy" }] },
      },
    };
    const resolved = resolveExecApprovalsFromFile({ file });
    expect(resolved.agent.ask).toBe("always");
    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual(["/bin/main", "/bin/legacy"]);
    expect(resolved.file.agents?.default).toBeUndefined();
  });
});

describe("normalizeExecApprovals handles string allowlist entries (#9790)", () => {
  it("converts bare string entries to proper ExecAllowlistEntry objects", () => {
    // Simulates a corrupted or legacy config where allowlist contains plain
    // strings (e.g. ["ls", "cat"]) instead of { pattern: "..." } objects.
    const file = {
      version: 1,
      agents: {
        main: {
          mode: "allowlist",
          allowlist: ["things", "remindctl", "memo", "which", "ls", "cat", "echo"],
        },
      },
    } as unknown as ExecApprovalsFile;

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    // Each entry must be a proper object with a pattern string, not a
    // spread-string like {"0":"t","1":"h","2":"i",...}
    for (const entry of entries) {
      expect(entry).toHaveProperty("pattern");
      expect(typeof entry.pattern).toBe("string");
      expect(entry.pattern.length).toBeGreaterThan(0);
      // Spread-string corruption would create numeric keys — ensure none exist
      expect(entry).not.toHaveProperty("0");
    }

    expect(entries.map((e) => e.pattern)).toEqual([
      "things",
      "remindctl",
      "memo",
      "which",
      "ls",
      "cat",
      "echo",
    ]);
  });

  it("preserves proper ExecAllowlistEntry objects unchanged", () => {
    const file: ExecApprovalsFile = {
      version: 1,
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/ls" }, { pattern: "/usr/bin/cat", id: "existing-id" }],
        },
      },
    };

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    expect(entries).toHaveLength(2);
    expect(entries[0]?.pattern).toBe("/usr/bin/ls");
    expect(entries[1]?.pattern).toBe("/usr/bin/cat");
    expect(entries[1]?.id).toBe("existing-id");
  });

  it("handles mixed string and object entries in the same allowlist", () => {
    const file = {
      version: 1,
      agents: {
        main: {
          allowlist: ["ls", { pattern: "/usr/bin/cat" }, "echo"],
        },
      },
    } as unknown as ExecApprovalsFile;

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.pattern)).toEqual(["ls", "/usr/bin/cat", "echo"]);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("0");
    }
  });

  it("drops empty string entries", () => {
    const file = {
      version: 1,
      agents: {
        main: {
          allowlist: ["", "  ", "ls"],
        },
      },
    } as unknown as ExecApprovalsFile;

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    // Only "ls" should survive; empty/whitespace strings should be dropped
    expect(entries.map((e) => e.pattern)).toEqual(["ls"]);
  });

  it("drops malformed object entries with missing/non-string patterns", () => {
    const file = {
      version: 1,
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/ls" }, {}, { pattern: 123 }, { pattern: "   " }, "echo"],
        },
      },
    } as unknown as ExecApprovalsFile;

    const normalized = normalizeExecApprovals(file);
    const entries = normalized.agents?.main?.allowlist ?? [];

    expect(entries.map((e) => e.pattern)).toEqual(["/usr/bin/ls", "echo"]);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("0");
    }
  });

  it("drops non-array allowlist values", () => {
    const file = {
      version: 1,
      agents: {
        main: {
          allowlist: "ls",
        },
      },
    } as unknown as ExecApprovalsFile;

    const normalized = normalizeExecApprovals(file);
    expect(normalized.agents?.main?.allowlist).toBeUndefined();
  });
});
