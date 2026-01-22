import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  analyzeArgvCommand,
  analyzeShellCommand,
  isSafeBinUsage,
  matchAllowlist,
  maxAsk,
  minSecurity,
  normalizeSafeBins,
  resolveCommandResolution,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
  type ExecAllowlistEntry,
} from "./exec-approvals.js";

function makePathEnv(binDir: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return { PATH: binDir };
  }
  return { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT;.COM" };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-exec-approvals-"));
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

  it("rejects chained commands", () => {
    const res = analyzeShellCommand({ command: "ls && rm -rf /" });
    expect(res.ok).toBe(false);
  });

  it("parses argv commands", () => {
    const res = analyzeArgvCommand({ argv: ["/bin/echo", "ok"] });
    expect(res.ok).toBe(true);
    expect(res.segments[0]?.argv).toEqual(["/bin/echo", "ok"]);
  });
});

describe("exec approvals safe bins", () => {
  it("allows safe bins with non-path args", () => {
    const dir = makeTempDir();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exeName = process.platform === "win32" ? "jq.exe" : "jq";
    const exe = path.join(binDir, exeName);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    const res = analyzeShellCommand({
      command: "jq .foo",
      cwd: dir,
      env: makePathEnv(binDir),
    });
    expect(res.ok).toBe(true);
    const segment = res.segments[0];
    const ok = isSafeBinUsage({
      argv: segment.argv,
      resolution: segment.resolution,
      safeBins: normalizeSafeBins(["jq"]),
      cwd: dir,
    });
    expect(ok).toBe(true);
  });

  it("blocks safe bins with file args", () => {
    const dir = makeTempDir();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exeName = process.platform === "win32" ? "jq.exe" : "jq";
    const exe = path.join(binDir, exeName);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    const file = path.join(dir, "secret.json");
    fs.writeFileSync(file, "{}");
    const res = analyzeShellCommand({
      command: "jq .foo secret.json",
      cwd: dir,
      env: makePathEnv(binDir),
    });
    expect(res.ok).toBe(true);
    const segment = res.segments[0];
    const ok = isSafeBinUsage({
      argv: segment.argv,
      resolution: segment.resolution,
      safeBins: normalizeSafeBins(["jq"]),
      cwd: dir,
    });
    expect(ok).toBe(false);
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
});

describe("exec approvals wildcard agent", () => {
  it("merges wildcard allowlist entries with agent entries", () => {
    const dir = makeTempDir();
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(dir);

    try {
      const approvalsPath = path.join(dir, ".clawdbot", "exec-approvals.json");
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
      homedirSpy.mockRestore();
    }
  });
});

describe("exec approvals default agent migration", () => {
  it("migrates legacy default agent entries to main", () => {
    const file = {
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
    const file = {
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
