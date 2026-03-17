import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, makePathEnv } from "./exec-approvals-test-helpers.js";
import {
  addAllowlistEntry,
  ensureExecApprovals,
  evaluateShellAllowlist,
  matchAllowlist,
  resolveAllowAlwaysPatterns,
  resolveSafeBins,
  type ExecAllowlistEntry,
  type ExecApprovalsFile,
} from "./exec-approvals.js";

const tempDirs: string[] = [];
const originalOpenClawHome = process.env.OPENCLAW_HOME;

beforeEach(() => {});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHomeDir(): string {
  const dir = makeTempDir();
  tempDirs.push(dir);
  process.env.OPENCLAW_HOME = dir;
  return dir;
}

function approvalsFilePath(homeDir: string): string {
  return path.join(homeDir, ".openclaw", "exec-approvals.json");
}

function readApprovalsFile(homeDir: string): ExecApprovalsFile {
  return JSON.parse(fs.readFileSync(approvalsFilePath(homeDir), "utf8")) as ExecApprovalsFile;
}

describe("exact-match allowlist entries", () => {
  const baseResolution = {
    rawExecutable: "python3",
    resolvedPath: "/usr/bin/python3",
    executableName: "python3",
  };

  it("exact-match entry matches only when path AND args match", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: ["safe.py"],
      matchMode: "exact",
    };
    const match = matchAllowlist([entry], baseResolution, ["python3", "safe.py"]);
    expect(match).toBe(entry);
  });

  it("exact-match entry rejects when args differ", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: ["safe.py"],
      matchMode: "exact",
    };
    const match = matchAllowlist([entry], baseResolution, ["python3", "evil.py"]);
    expect(match).toBeNull();
  });

  it("exact-match entry rejects when arg count differs", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: ["safe.py"],
      matchMode: "exact",
    };
    // Extra args
    const match1 = matchAllowlist([entry], baseResolution, ["python3", "safe.py", "--verbose"]);
    expect(match1).toBeNull();
    // No args
    const match2 = matchAllowlist([entry], baseResolution, ["python3"]);
    expect(match2).toBeNull();
  });

  it("path-only entries (no matchMode) match any args for backward compat", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
    };
    expect(matchAllowlist([entry], baseResolution, ["python3", "safe.py"])).toBe(entry);
    expect(matchAllowlist([entry], baseResolution, ["python3", "evil.py"])).toBe(entry);
    expect(matchAllowlist([entry], baseResolution, ["python3"])).toBe(entry);
  });

  it("exact-match entry with null args matches any args (like path-only)", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: null,
      matchMode: "exact",
    };
    expect(matchAllowlist([entry], baseResolution, ["python3", "safe.py"])).toBe(entry);
    expect(matchAllowlist([entry], baseResolution, ["python3", "evil.py"])).toBe(entry);
  });

  it("exact-match entry with empty args matches only bare binary invocation", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: [],
      matchMode: "exact",
    };
    expect(matchAllowlist([entry], baseResolution, ["python3"])).toBe(entry);
    expect(matchAllowlist([entry], baseResolution, ["python3", "safe.py"])).toBeNull();
  });

  it("exact-match respects order and content of all args", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: ["-m", "pytest", "tests/"],
      matchMode: "exact",
    };
    expect(matchAllowlist([entry], baseResolution, ["python3", "-m", "pytest", "tests/"])).toBe(
      entry,
    );
    expect(
      matchAllowlist([entry], baseResolution, ["python3", "pytest", "-m", "tests/"]),
    ).toBeNull();
  });
});

describe("exact-match with shell wrapper unwrapping", () => {
  function makeExecutable(dir: string, name: string): string {
    const fileName = process.platform === "win32" ? `${name}.exe` : name;
    const exe = path.join(dir, fileName);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    return exe;
  }

  it("shell wrapper unwrapping preserves inner args", () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir();
    const python3 = makeExecutable(dir, "python3");
    const entries = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/bin/zsh -lc 'python3 safe.py'",
          argv: ["/bin/zsh", "-lc", "python3 safe.py"],
          resolution: {
            rawExecutable: "/bin/zsh",
            resolvedPath: "/bin/zsh",
            executableName: "zsh",
          },
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(entries).toEqual([{ pattern: python3, args: ["safe.py"] }]);
  });

  it("dispatch wrapper unwrapping preserves inner args", () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir();
    const python3 = makeExecutable(dir, "python3");
    const entries = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/usr/bin/nice python3 safe.py",
          argv: ["/usr/bin/nice", "python3", "safe.py"],
          resolution: {
            rawExecutable: "/usr/bin/nice",
            resolvedPath: "/usr/bin/nice",
            executableName: "nice",
          },
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(entries).toEqual([{ pattern: python3, args: ["safe.py"] }]);
  });

  it("chain (&&) creates separate exact entries per segment", () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir();
    const python3 = makeExecutable(dir, "python3");
    const rg = makeExecutable(dir, "rg");
    const entries = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/bin/zsh -lc 'python3 safe.py && rg needle'",
          argv: ["/bin/zsh", "-lc", "python3 safe.py && rg needle"],
          resolution: {
            rawExecutable: "/bin/zsh",
            resolvedPath: "/bin/zsh",
            executableName: "zsh",
          },
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(entries).toEqual([
      { pattern: python3, args: ["safe.py"] },
      { pattern: rg, args: ["needle"] },
    ]);
  });
});

describe("dedup on pattern+args combo", () => {
  it("deduplicates entries with same pattern and args", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(100_000);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["safe.py"]);
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["safe.py"]);

    const file = readApprovalsFile(dir);
    expect(file.agents?.worker?.allowlist).toHaveLength(1);
    expect(file.agents?.worker?.allowlist?.[0]).toEqual(
      expect.objectContaining({
        pattern: "/usr/bin/python3",
        args: ["safe.py"],
        matchMode: "exact",
      }),
    );
  });

  it("allows separate entries for same binary with different args", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(100_000);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["safe.py"]);
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["other.py"]);

    const file = readApprovalsFile(dir);
    expect(file.agents?.worker?.allowlist).toHaveLength(2);
    expect(file.agents?.worker?.allowlist?.[0]?.args).toEqual(["safe.py"]);
    expect(file.agents?.worker?.allowlist?.[1]?.args).toEqual(["other.py"]);
  });

  it("allows path-only and exact-match entries for same binary", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(100_000);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3");
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["safe.py"]);

    const file = readApprovalsFile(dir);
    expect(file.agents?.worker?.allowlist).toHaveLength(2);
    expect(file.agents?.worker?.allowlist?.[0]?.matchMode).toBeUndefined();
    expect(file.agents?.worker?.allowlist?.[1]?.matchMode).toBe("exact");
  });
});

describe("exact-match integration with evaluateShellAllowlist", () => {
  function makeExecutable(dir: string, name: string): string {
    const fileName = process.platform === "win32" ? `${name}.exe` : name;
    const exe = path.join(dir, fileName);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    return exe;
  }

  it("python3 safe.py allow-always does NOT approve python3 evil.py", () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir();
    const python3 = makeExecutable(dir, "python3");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    // Resolve allow-always entries for python3 safe.py
    const firstAnalysis = evaluateShellAllowlist({
      command: "python3 safe.py",
      allowlist: [],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    const entries = resolveAllowAlwaysPatterns({
      segments: firstAnalysis.segments,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(entries).toEqual([{ pattern: python3, args: ["safe.py"] }]);

    // Build allowlist from resolved entries
    const allowlist: ExecAllowlistEntry[] = entries.map((e) => ({
      pattern: e.pattern,
      ...(e.args != null ? { args: e.args, matchMode: "exact" as const } : {}),
    }));

    // Same command should match
    const sameCmd = evaluateShellAllowlist({
      command: "python3 safe.py",
      allowlist,
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(sameCmd.allowlistSatisfied).toBe(true);

    // Different args should NOT match
    const differentCmd = evaluateShellAllowlist({
      command: "python3 evil.py",
      allowlist,
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(differentCmd.allowlistSatisfied).toBe(false);
  });
});
